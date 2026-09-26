import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Page } from "../../app/Shell";
import { PERMISSIONS, PERMISSION_CODES, PERMISSION_GROUPS, type Permission } from "../../domain/permissions";
import { dateOnly } from "../../lib/format";
import { rpc, useAction, useRoles, useTeam } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Invitation, TeamMember } from "../../lib/types";
import { Badge, Banner, Button, Card, Checkbox, Dialog, Empty, Icon, IconButton, Loading, Select, Tabs, TextField, initials, useToast } from "../../ui/components";

type TabKey = "members" | "roles" | "invites";

export function TeamPage() {
  const [tab, setTab] = useState<TabKey>("members");
  return (
    <Page title="Equipo">
      <div className="col gap-16">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "members", label: "Personas" },
            { value: "roles", label: "Roles y permisos" },
            { value: "invites", label: "Invitaciones" },
          ]}
        />
        {tab === "members" ? <Members /> : tab === "roles" ? <Roles /> : <Invitations />}
      </div>
    </Page>
  );
}

function Members() {
  const team = useTeam();
  const roles = useRoles();
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [inviting, setInviting] = useState(false);
  if (team.isLoading) return <Loading />;
  return (
    <>
      <div className="row end">
        <Button icon="person_add" onClick={() => setInviting(true)}>
          Invitar
        </Button>
      </div>
      <Card variant="flush">
        <div className="list">
          {(team.data ?? []).map((m) => (
            <div key={m.id} className="list-item clickable" onClick={() => setEditing(m)} style={m.active ? undefined : { opacity: 0.55 }}>
              <span className="lead">{initials(m.display_name)}</span>
              <div className="grow">
                <div className="headline">{m.display_name}</div>
                <div className="supporting">{[m.email, m.phone].filter(Boolean).join(" · ")}</div>
              </div>
              <Badge tone={m.is_owner ? "primary" : m.role_home === "courier" ? "secondary" : "neutral"}>{m.role_name}</Badge>
              {!m.active && <Badge tone="error">Inactivo</Badge>}
            </div>
          ))}
        </div>
      </Card>
      {editing && <MemberDialog member={editing} roles={roles.data ?? []} onClose={() => setEditing(null)} />}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}

function MemberDialog({ member, roles, onClose }: { member: TeamMember; roles: { id: string; name: string; is_owner: boolean }[]; onClose: () => void }) {
  const [role, setRole] = useState(member.role_id);
  const [displayName, setDisplayName] = useState(member.display_name);
  const [phone, setPhone] = useState(member.phone ?? "");
  const [active, setActive] = useState(member.active);
  const save = useAction(
    () => rpc("update_member", { p_member: member.id, p_role: role, p_display_name: displayName, p_phone: phone || null, p_active: active }),
    { success: "Guardado", invalidate: [["team"], ["memberships"]], dispatch: false },
  );
  return (
    <Dialog
      open
      title={member.display_name}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <TextField label="Nombre" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <TextField label="Teléfono" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Select label="Rol" value={role} onChange={(e) => setRole(e.target.value)} options={roles.map((r) => ({ value: r.id, label: r.name }))} />
        <Checkbox label="Activo (puede entrar)" checked={active} onChange={setActive} />
      </div>
    </Dialog>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenantId, tenant } = useTenant();
  const roles = useRoles();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setLink(null);
      setRole(roles.data?.find((r) => r.key === "front_desk")?.id ?? roles.data?.find((r) => !r.is_owner)?.id ?? "");
    }
  }, [open, roles.data]);
  const create = useAction(
    () => rpc<{ token: string }>("create_invitation", { p_tenant: tenantId, p_role: role, p_email: email || null, p_display_name: name || null }),
    { invalidate: [["invitations"]], dispatch: false },
  );
  return (
    <Dialog
      open={open}
      title="Invitar al equipo"
      onClose={onClose}
      actions={
        link ? (
          <Button onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button variant="text" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              loading={create.isPending}
              disabled={!role}
              onClick={() => create.mutate(undefined, { onSuccess: (r) => setLink(`${window.location.origin}/invite/${(r as { token: string }).token}`) })}
            >
              Crear invitación
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="col gap-16">
          <Banner tone="success">Comparte este enlace. Vence en 7 días y sirve una sola vez.</Banner>
          <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
          <div className="row wrap">
            <Button variant="tonal" icon="content_copy" onClick={() => navigator.clipboard?.writeText(link).then(() => toast.show("Copiado"))}>
              Copiar
            </Button>
            <a className="btn outlined" href={`https://wa.me/?text=${encodeURIComponent(`Te invito a ${tenant?.tenant_name} en Dark Laundry OS: ${link}`)}`} target="_blank" rel="noreferrer">
              <Icon name="chat" /> WhatsApp
            </a>
          </div>
        </div>
      ) : (
        <div className="col gap-16">
          <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField label="Correo (opcional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="Si lo indicas, solo esa cuenta podrá aceptar" />
          <Select label="Rol" value={role} onChange={(e) => setRole(e.target.value)} options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />
        </div>
      )}
    </Dialog>
  );
}

function Invitations() {
  const { tenantId } = useTenant();
  const roles = useRoles();
  const q = useQuery({
    queryKey: ["invitations", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from("tenant_invitations").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return data as Invitation[];
    },
  });
  const revoke = useAction((id: string) => rpc("revoke_invitation", { p_invitation: id }), { success: "Invitación revocada", invalidate: [["invitations"]], dispatch: false });
  const roleName = new Map((roles.data ?? []).map((r) => [r.id, r.name]));
  if (q.isLoading) return <Loading />;
  return (
    <Card variant="flush">
      {!q.data?.length ? (
        <Empty icon="mail" title="Sin invitaciones" />
      ) : (
        <div className="list">
          {q.data.map((i) => {
            const state = i.accepted_at ? "Aceptada" : i.revoked_at ? "Revocada" : new Date(i.expires_at) < new Date() ? "Vencida" : "Pendiente";
            return (
              <div key={i.id} className="list-item">
                <div className="grow">
                  <div className="headline">{i.display_name || i.email || "Invitación abierta"}</div>
                  <div className="supporting">
                    {roleName.get(i.role_id)} · creada {dateOnly(i.created_at)}
                  </div>
                </div>
                <Badge tone={state === "Aceptada" ? "success" : state === "Pendiente" ? "warning" : "neutral"}>{state}</Badge>
                {state === "Pendiente" && <IconButton icon="block" label="Revocar" onClick={() => revoke.mutate(i.id)} />}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Roles() {
  const roles = useRoles();
  const [editing, setEditing] = useState<{ id: string | null; name: string; description: string; home: "backoffice" | "courier"; permissions: string[] } | null>(null);
  if (roles.isLoading) return <Loading />;
  return (
    <>
      <div className="row end">
        <Button icon="add" onClick={() => setEditing({ id: null, name: "", description: "", home: "backoffice", permissions: [] })}>
          Rol
        </Button>
      </div>
      <div className="grid cols-2">
        {(roles.data ?? []).map((r) => (
          <Card
            key={r.id}
            title={r.name}
            action={
              !r.is_owner && (
                <IconButton
                  icon="edit"
                  label="Editar"
                  onClick={() => setEditing({ id: r.id, name: r.name, description: r.description ?? "", home: r.home, permissions: r.permissions })}
                />
              )
            }
          >
            <p className="body-m muted" style={{ marginTop: 0 }}>
              {r.description}
              {r.home === "courier" && " · Entra a la vista de courier"}
            </p>
            <div className="row wrap gap-4">
              {r.is_owner ? (
                <Badge tone="primary">Todos los permisos</Badge>
              ) : (
                r.permissions.map((p) => (
                  <Badge key={p} tone="outline">
                    {PERMISSIONS[p as Permission] ?? p}
                  </Badge>
                ))
              )}
            </div>
          </Card>
        ))}
      </div>
      {editing && <RoleDialog role={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RoleDialog({
  role,
  onClose,
}: {
  role: { id: string | null; name: string; description: string; home: "backoffice" | "courier"; permissions: string[] };
  onClose: () => void;
}) {
  const { tenantId } = useTenant();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [home, setHome] = useState(role.home);
  const [perms, setPerms] = useState<string[]>(role.permissions);
  const save = useAction(
    () => rpc("save_role", { p_tenant: tenantId, p_role: role.id, p_name: name, p_description: description || null, p_home: home, p_permissions: perms }),
    { success: "Rol guardado", invalidate: [["roles"], ["memberships"], ["team"]], dispatch: false },
  );
  const remove = useAction(() => rpc("delete_role", { p_role: role.id }), { success: "Rol eliminado", invalidate: [["roles"]], dispatch: false });
  const groups = [...new Set(PERMISSION_GROUPS.map((g) => g.label))];
  return (
    <Dialog
      open
      wide
      title={role.id ? `Editar rol: ${role.name}` : "Nuevo rol"}
      onClose={onClose}
      actions={
        <>
          {role.id && (
            <Button variant="danger-text" style={{ marginRight: "auto" }} onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
              Eliminar
            </Button>
          )}
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <div className="grid cols-2">
          <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
          <Select
            label="Al entrar ve"
            value={home}
            onChange={(e) => setHome(e.target.value as "backoffice" | "courier")}
            options={[
              { value: "backoffice", label: "Back office" },
              { value: "courier", label: "App de courier" },
            ]}
          />
        </div>
        <TextField label="Descripción" value={description} onChange={(e) => setDescription(e.target.value)} />
        {groups.map((g) => {
          const codes = PERMISSION_CODES.filter((c) => PERMISSION_GROUPS.some((pg) => pg.label === g && c.startsWith(pg.prefix)));
          return (
            <div key={g}>
              <div className="title-s">{g}</div>
              <div className="grid cols-2" style={{ gap: 0 }}>
                {codes.map((c) => (
                  <Checkbox key={c} label={PERMISSIONS[c]} checked={perms.includes(c)} onChange={(v) => setPerms((p) => (v ? [...p, c] : p.filter((x) => x !== c)))} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
