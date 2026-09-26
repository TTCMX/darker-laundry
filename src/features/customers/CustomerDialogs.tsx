import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { normalizePhone } from "../../domain/phone";
import { errorMessage } from "../../lib/errors";
import { useCatalog } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Address, Customer } from "../../lib/types";
import { Banner, Button, Checkbox, Dialog, Select, TextArea, TextField, useToast } from "../../ui/components";

export function CustomerDialog({
  open,
  customer,
  onClose,
  onSaved,
  initialQuery,
}: {
  open: boolean;
  customer?: Customer | null;
  onClose: () => void;
  onSaved: (c: Customer) => void;
  initialQuery?: string;
}) {
  const { tenantId, tenant } = useTenant();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const q = initialQuery ?? "";
    const looksLikePhone = /^[\d\s+()-]{7,}$/.test(q);
    setName(customer?.name ?? (looksLikePhone ? "" : q));
    setPhone(customer?.phone ?? (looksLikePhone ? q : ""));
    setEmail(customer?.email ?? "");
    setNotes(customer?.notes ?? "");
    setError(null);
  }, [open, customer, initialQuery]);

  const phoneOk = !phone.trim() || normalizePhone(phone, tenant?.country) !== null;

  const save = async () => {
    if (!name.trim()) return setError("El nombre es obligatorio.");
    if (!phoneOk) return setError("El teléfono no es válido.");
    setSaving(true);
    setError(null);
    const values = { name: name.trim(), phone: phone.trim() || null, email: email.trim() || null, notes: notes.trim() || null };
    const r = customer
      ? await supabase.from("customers").update(values).eq("id", customer.id).select().single()
      : await supabase.from("customers").insert({ ...values, tenant_id: tenantId }).select().single();
    setSaving(false);
    if (r.error) return setError(errorMessage(r.error));
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["customer"] });
    onSaved(r.data as Customer);
  };

  return (
    <Dialog
      open={open}
      title={customer ? "Editar cliente" : "Nuevo cliente"}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} loading={saving}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        <TextField
          label="Teléfono"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={phoneOk ? null : "Formato no reconocido"}
          hint="Con o sin lada; se guarda en formato internacional"
        />
        <TextField label="Correo" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="Para enviar recibos y avisos" />
        <TextArea label="Notas" value={notes} onChange={(e) => setNotes(e.target.value)} hint="Preferencias, alergias a detergentes, etc." />
        {error && <Banner tone="error">{error}</Banner>}
      </div>
    </Dialog>
  );
}

export function AddressDialog({
  open,
  customerId,
  address,
  onClose,
  onSaved,
}: {
  open: boolean;
  customerId: string;
  address?: Address | null;
  onClose: () => void;
  onSaved: (a: Address) => void;
}) {
  const { tenantId } = useTenant();
  const catalog = useCatalog();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    label: "",
    line1: "",
    line2: "",
    neighborhood: "",
    city: "",
    postal_code: "",
    instructions: "",
    zone_id: "",
    is_default: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      label: address?.label ?? "",
      line1: address?.line1 ?? "",
      line2: address?.line2 ?? "",
      neighborhood: address?.neighborhood ?? "",
      city: address?.city ?? "",
      postal_code: address?.postal_code ?? "",
      instructions: address?.instructions ?? "",
      zone_id: address?.zone_id ?? "",
      is_default: address?.is_default ?? true,
    });
    setError(null);
  }, [open, address]);

  const zones = (catalog.data?.zones ?? []).filter((z) => z.active);
  // Suggest the zone by postal code.
  useEffect(() => {
    if (form.zone_id || !form.postal_code) return;
    const match = zones.find((z) => z.postal_codes.includes(form.postal_code.trim()));
    if (match) setForm((f) => ({ ...f, zone_id: match.id }));
  }, [form.postal_code, form.zone_id, zones]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!form.line1.trim()) return setError("La calle y número son obligatorios.");
    setSaving(true);
    setError(null);
    if (form.is_default) {
      await supabase.from("customer_addresses").update({ is_default: false }).eq("customer_id", customerId).neq("id", address?.id ?? "00000000-0000-0000-0000-000000000000");
    }
    const values = {
      label: form.label.trim() || null,
      line1: form.line1.trim(),
      line2: form.line2.trim() || null,
      neighborhood: form.neighborhood.trim() || null,
      city: form.city.trim() || null,
      postal_code: form.postal_code.trim() || null,
      instructions: form.instructions.trim() || null,
      zone_id: form.zone_id || null,
      is_default: form.is_default,
    };
    const r = address
      ? await supabase.from("customer_addresses").update(values).eq("id", address.id).select().single()
      : await supabase.from("customer_addresses").insert({ ...values, tenant_id: tenantId, customer_id: customerId }).select().single();
    setSaving(false);
    if (r.error) return setError(errorMessage(r.error));
    qc.invalidateQueries({ queryKey: ["addresses", customerId] });
    qc.invalidateQueries({ queryKey: ["customer"] });
    toast.show("Dirección guardada");
    onSaved(r.data as Address);
  };

  return (
    <Dialog
      open={open}
      title={address ? "Editar dirección" : "Nueva dirección"}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} loading={saving}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <TextField label="Calle y número" value={form.line1} onChange={set("line1")} autoFocus required />
        <div className="grid cols-2">
          <TextField label="Interior / depto." value={form.line2} onChange={set("line2")} />
          <TextField label="Etiqueta" placeholder="Casa, oficina…" value={form.label} onChange={set("label")} />
          <TextField label="Colonia" value={form.neighborhood} onChange={set("neighborhood")} />
          <TextField label="Código postal" value={form.postal_code} onChange={set("postal_code")} inputMode="numeric" />
          <TextField label="Ciudad" value={form.city} onChange={set("city")} />
          <Select
            label="Zona de entrega"
            value={form.zone_id}
            onChange={set("zone_id")}
            placeholder="Sin zona (tarifa general)"
            options={zones.map((z) => ({ value: z.id, label: z.name }))}
          />
        </div>
        <TextArea label="Indicaciones" value={form.instructions} onChange={set("instructions")} hint="Referencias para el courier" />
        <Checkbox label="Dirección principal" checked={form.is_default} onChange={(v) => setForm((f) => ({ ...f, is_default: v }))} />
        {error && <Banner tone="error">{error}</Banner>}
      </div>
    </Dialog>
  );
}

export const formatAddress = (a: Partial<Address> | Record<string, unknown> | null | undefined) => {
  if (!a) return "";
  const x = a as Record<string, string | null | undefined>;
  return [x.line1, x.line2, x.neighborhood, x.city, x.postal_code].filter(Boolean).join(", ");
};

export const mapsUrl = (a: Partial<Address> | Record<string, unknown> | null | undefined) => {
  const x = (a ?? {}) as Record<string, unknown>;
  if (typeof x.lat === "number" && typeof x.lng === "number") {
    return `https://www.google.com/maps/dir/?api=1&destination=${x.lat},${x.lng}`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(formatAddress(a))}`;
};
