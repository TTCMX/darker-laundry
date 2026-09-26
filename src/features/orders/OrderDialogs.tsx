import { useEffect, useState } from "react";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "../../domain/payments";
import { newIdempotencyKey } from "../../lib/api";
import { centsToInput, inputToCents, money, todayISO } from "../../lib/format";
import { rpc, uploadEvidence, useAction, useTeam } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Address, Order, Payment, ProductionStep, QualityIssue } from "../../lib/types";
import { Banner, Button, Dialog, Segmented, Select, TextArea, TextField } from "../../ui/components";
import { formatAddress } from "../customers/CustomerDialogs";
import { ISSUE_STATUS_LABEL, ISSUE_TYPE_LABEL, SEVERITY_LABEL } from "../shared";

export function PaymentDialog({
  open,
  order,
  onClose,
  deliveryId,
}: {
  open: boolean;
  order: Pick<Order, "id" | "number" | "balance_cents">;
  onClose: () => void;
  deliveryId?: string | null;
}) {
  const { settings } = useTenant();
  const methods = settings.payments.methods.filter((m) => m !== "online");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  useEffect(() => {
    if (open) {
      setAmount(centsToInput(order.balance_cents));
      setMethod((methods[0] as PaymentMethod) ?? "cash");
      setNotes("");
      setKey(newIdempotencyKey());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.balance_cents]);

  const action = useAction(
    () =>
      rpc("record_payment", {
        p_order: order.id,
        p_amount_cents: inputToCents(amount),
        p_method: method,
        // One key per dialog: a double tap or a retry records one payment.
        p_idempotency_key: key,
        p_notes: notes || null,
        p_delivery: deliveryId ?? null,
      }),
    { success: "Pago registrado", invalidate: [["order"], ["orders"], ["dashboard"], ["courier"], ["payments"]] },
  );
  const cents = inputToCents(amount) ?? 0;

  return (
    <Dialog
      open={open}
      title={`Registrar pago · #${order.number}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button icon="payments" loading={action.isPending} disabled={cents <= 0} onClick={() => action.mutate(undefined, { onSuccess: onClose })}>
            Cobrar {cents > 0 ? money(cents) : ""}
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <p className="body-m muted" style={{ margin: 0 }}>
          Saldo pendiente: <strong>{money(order.balance_cents)}</strong>
        </p>
        <TextField label="Monto" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        <Segmented value={method} onChange={setMethod} options={methods.map((m) => ({ value: m as PaymentMethod, label: PAYMENT_METHOD_LABEL[m as PaymentMethod] }))} />
        <TextField label="Referencia / nota" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Dialog>
  );
}

export function RefundDialog({ open, payment, onClose }: { open: boolean; payment: Payment | null; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  useEffect(() => {
    if (open && payment) {
      setAmount(centsToInput(payment.amount_cents));
      setReason("");
      setKey(newIdempotencyKey());
    }
  }, [open, payment]);
  const action = useAction(
    () => rpc("record_refund", { p_payment: payment!.id, p_amount_cents: inputToCents(amount), p_reason: reason, p_idempotency_key: key }),
    { success: "Reembolso registrado", invalidate: [["order"], ["orders"], ["payments"], ["dashboard"]] },
  );
  return (
    <Dialog
      open={open}
      title="Registrar reembolso"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={action.isPending} disabled={!reason.trim()} onClick={() => action.mutate(undefined, { onSuccess: onClose })}>
            Reembolsar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        {payment?.provider !== "manual" && (
          <Banner tone="warning">Este pago fue en línea: haz también el reembolso en el panel del proveedor.</Banner>
        )}
        <TextField label="Monto" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <TextArea label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </div>
    </Dialog>
  );
}

export function ScheduleDialog({
  open,
  order,
  type,
  addresses,
  onClose,
}: {
  open: boolean;
  order: Order;
  type: "pickup" | "delivery";
  addresses: Address[];
  onClose: () => void;
}) {
  const { settings } = useTenant();
  const team = useTeam();
  const couriers = (team.data ?? []).filter((m) => m.active && m.role_home === "courier");
  const windows = settings.delivery.windows;
  const [date, setDate] = useState(todayISO());
  const [windowId, setWindowId] = useState("");
  const [addressId, setAddressId] = useState("");
  const [courier, setCourier] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (!open) return;
    setDate(type === "delivery" && order.promised_at ? order.promised_at.slice(0, 10) : todayISO());
    setWindowId(windows[0]?.id ?? "");
    setAddressId((type === "pickup" ? order.pickup_address_id : order.delivery_address_id) ?? addresses[0]?.id ?? "");
    setCourier("");
    setNotes("");
  }, [open, type, order, addresses, windows]);
  const w = windows.find((x) => x.id === windowId);
  const action = useAction(
    () =>
      rpc("schedule_delivery", {
        p_order: order.id,
        p_type: type,
        p_date: date,
        p_window_label: w ? `${w.label} ${w.start}–${w.end}` : null,
        p_window_start: w?.start ?? null,
        p_window_end: w?.end ?? null,
        p_address_id: addressId || null,
        p_notes: notes || null,
        p_courier: courier || null,
      }),
    { success: type === "pickup" ? "Recolección programada" : "Entrega programada", invalidate: [["order"], ["orders"], ["deliveries"], ["dashboard"]] },
  );
  return (
    <Dialog
      open={open}
      title={type === "pickup" ? "Programar recolección" : "Programar entrega"}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={action.isPending} disabled={!addressId} onClick={() => action.mutate(undefined, { onSuccess: onClose })}>
            Programar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        {addresses.length === 0 && <Banner tone="warning">El cliente no tiene direcciones. Agrégala desde su perfil.</Banner>}
        <Select label="Dirección" value={addressId} onChange={(e) => setAddressId(e.target.value)} options={addresses.map((a) => ({ value: a.id, label: formatAddress(a) }))} />
        <div className="grid cols-2">
          <TextField label="Fecha" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Select label="Horario" value={windowId} onChange={(e) => setWindowId(e.target.value)} placeholder="Sin horario" options={windows.map((x) => ({ value: x.id, label: `${x.label} ${x.start}–${x.end}` }))} />
        </div>
        <Select
          label="Courier"
          value={courier}
          onChange={(e) => setCourier(e.target.value)}
          placeholder={couriers.length === 1 ? `Automático (${couriers[0]!.display_name})` : "Sin asignar"}
          options={couriers.map((c) => ({ value: c.user_id, label: c.display_name }))}
        />
        <TextArea label="Notas para el courier" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>
    </Dialog>
  );
}

export function IssueDialog({
  open,
  order,
  steps,
  onClose,
}: {
  open: boolean;
  order: Pick<Order, "id" | "tenant_id" | "number">;
  steps: ProductionStep[];
  onClose: () => void;
}) {
  const team = useTeam();
  const [stepId, setStepId] = useState("");
  const [type, setType] = useState("damage");
  const [severity, setSeverity] = useState<QualityIssue["severity"]>("medium");
  const [description, setDescription] = useState("");
  const [responsible, setResponsible] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  useEffect(() => {
    if (!open) return;
    const current = steps.find((s) => s.status === "pending" || s.status === "in_progress");
    setStepId(current?.id ?? "");
    setType("damage");
    setSeverity("medium");
    setDescription("");
    setResponsible("");
    setFiles([]);
  }, [open, steps]);
  const action = useAction(
    async () => {
      const paths = await Promise.all(files.map((f) => uploadEvidence(order.tenant_id, f, `orders/${order.id}/issues`)));
      const { error } = await supabase.from("quality_issues").insert({
        tenant_id: order.tenant_id,
        order_id: order.id,
        production_step_id: stepId || null,
        type,
        severity,
        description,
        responsible_user_id: responsible || null,
        photo_paths: paths,
      });
      if (error) throw error;
    },
    { success: "Incidencia registrada", invalidate: [["order"], ["dashboard"]], dispatch: false },
  );
  return (
    <Dialog
      open={open}
      title={`Reportar incidencia · #${order.number}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={action.isPending} disabled={!description.trim()} onClick={() => action.mutate(undefined, { onSuccess: onClose })}>
            Reportar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <div className="grid cols-2">
          <Select label="Tipo" value={type} onChange={(e) => setType(e.target.value)} options={Object.entries(ISSUE_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          <Select
            label="Severidad"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as QualityIssue["severity"])}
            options={Object.entries(SEVERITY_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Select label="Fase" value={stepId} onChange={(e) => setStepId(e.target.value)} placeholder="General" options={steps.map((s) => ({ value: s.id, label: s.name }))} />
          <Select
            label="Responsable"
            value={responsible}
            onChange={(e) => setResponsible(e.target.value)}
            placeholder="Sin asignar"
            options={(team.data ?? []).filter((m) => m.active).map((m) => ({ value: m.user_id, label: m.display_name }))}
          />
        </div>
        <TextArea label="Descripción" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ej. Camisa blanca con mancha después del lavado" required />
        <div className="field">
          <label>Fotos (opcional)</label>
          <input type="file" accept="image/*" capture="environment" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </div>
        <p className="body-s muted" style={{ margin: 0 }}>
          Las incidencias sirven para dar seguimiento; no generan penalizaciones automáticas.
        </p>
      </div>
    </Dialog>
  );
}

export function ResolveIssueDialog({ open, issue, onClose }: { open: boolean; issue: QualityIssue | null; onClose: () => void }) {
  const [status, setStatus] = useState<QualityIssue["status"]>("resolved");
  const [resolution, setResolution] = useState("");
  useEffect(() => {
    if (open && issue) {
      setStatus(issue.status === "open" ? "resolved" : issue.status);
      setResolution(issue.resolution ?? "");
    }
  }, [open, issue]);
  const action = useAction(
    async () => {
      const { error } = await supabase.from("quality_issues").update({ status, resolution: resolution || null }).eq("id", issue!.id);
      if (error) throw error;
    },
    { success: "Incidencia actualizada", invalidate: [["order"], ["dashboard"]], dispatch: false },
  );
  return (
    <Dialog
      open={open}
      title="Seguimiento de incidencia"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={action.isPending} onClick={() => action.mutate(undefined, { onSuccess: onClose })}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <p className="body-m" style={{ margin: 0 }}>
          {issue?.description}
        </p>
        <Select
          label="Estado"
          value={status}
          onChange={(e) => setStatus(e.target.value as QualityIssue["status"])}
          options={Object.entries(ISSUE_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <TextArea label="Resolución" value={resolution} onChange={(e) => setResolution(e.target.value)} />
      </div>
    </Dialog>
  );
}

export function ReasonDialog({
  open,
  title,
  label,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  loading,
  required = true,
}: {
  open: boolean;
  title: string;
  label: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  loading?: boolean;
  required?: boolean;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={danger ? "danger" : "filled"} loading={loading} disabled={required && !reason.trim()} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <TextArea label={label} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
    </Dialog>
  );
}
