import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../../lib/errors";
import { dateTime, money, qty, unitLabel } from "../../lib/format";
import { bluetoothSupported, connectPrinter, isCancelled, printBytes, printerPrefs, printerStatus, unsupportedMessage, usePrinter } from "../../lib/printing/bluetooth";
import { buildReceipt, layout, type PaperWidth, type ReceiptDoc } from "../../lib/printing/escpos";
import { composeReceipt } from "../../lib/printing/receipt";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Address, Customer, Order, OrderItem, Payment } from "../../lib/types";
import type { TenantSettings } from "../../domain/settings";
import { IconButton, useToast } from "../../ui/components";
import { formatAddress } from "../customers/CustomerDialogs";

export interface ReceiptBundle {
  order: Order & { customers: Customer };
  items: OrderItem[];
  payments: Payment[];
  addresses: Address[];
}

interface Extras {
  business: { name: string; legal_name: string | null; tax_id: string | null; phone: string | null; address: string | null };
  loyalty: { earned: number; balance: number } | null;
}

const extrasKey = (orderId: string) => ["receipt-extras", orderId];

function extrasQuery(tenantId: string, order: Order) {
  return {
    queryKey: extrasKey(order.id),
    staleTime: 30_000,
    queryFn: async (): Promise<Extras> => {
      const [t, c, e] = await Promise.all([
        supabase.from("tenants").select("name, legal_name, tax_id, phone, address").eq("id", tenantId).single(),
        supabase.from("customer_overview").select("points_balance").eq("id", order.customer_id).maybeSingle(),
        supabase.from("loyalty_transactions").select("points").eq("order_id", order.id).eq("kind", "earn"),
      ]);
      if (t.error) throw t.error;
      return {
        business: t.data as Extras["business"],
        loyalty: c.data ? { balance: Number(c.data.points_balance ?? 0), earned: (e.data ?? []).reduce((s, x) => s + Number(x.points), 0) } : null,
      };
    },
  };
}

function toDoc(bundle: ReceiptBundle, extras: Extras, settings: TenantSettings, link: string): ReceiptDoc {
  const { order } = bundle;
  const address = order.fulfillment === "delivery" ? bundle.addresses.find((a) => a.id === (order.delivery_address_id ?? order.pickup_address_id)) : null;
  return composeReceipt({
    business: extras.business,
    settings: settings.receipts,
    loyaltySettings: settings.loyalty,
    order,
    customer: { name: order.customers.name, phone: order.customers.phone },
    address: address ? formatAddress(address) : null,
    items: bundle.items,
    payments: bundle.payments,
    loyalty: extras.loyalty,
    trackingUrl: link,
    printedAt: new Date(),
    fmt: { money, dateTime, qty, unit: unitLabel },
  });
}

/** Prints the ticket on the Bluetooth printer (connecting first if needed). */
export async function printOrderReceipt(qc: QueryClient, tenantId: string, settings: TenantSettings, bundle: ReceiptBundle, link: string) {
  if (!bluetoothSupported()) throw new Error(unsupportedMessage());
  // The device chooser needs the click's user activation: ask before any network call.
  if (printerStatus() !== "connected") await connectPrinter();
  // Always print what is in the database right now (e.g. a payment just recorded).
  await Promise.all([
    qc.refetchQueries({ queryKey: ["order", bundle.order.id], exact: true }),
    qc.invalidateQueries({ queryKey: extrasKey(bundle.order.id) }),
  ]);
  const fresh = qc.getQueryData<ReceiptBundle>(["order", bundle.order.id]) ?? bundle;
  const extras = await qc.fetchQuery(extrasQuery(tenantId, fresh.order));
  await printBytes(buildReceipt(toDoc(fresh, extras, settings, link), printerPrefs().width));
}

/** Print icon for the order header: Bluetooth ticket in one tap. */
export function PrintReceiptButton({ bundle, link }: { bundle: ReceiptBundle; link: string }) {
  const { tenantId, settings } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const printer = usePrinter();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!bluetoothSupported()) {
      toast.show(unsupportedMessage(), { error: true, action: { label: "Navegador", run: () => window.print() } });
      return;
    }
    setBusy(true);
    try {
      await printOrderReceipt(qc, tenantId, settings, bundle, link);
      toast.show("Nota enviada a la impresora");
    } catch (err) {
      if (!isCancelled(err)) toast.show(`No se pudo imprimir: ${errorMessage(err)}`, { error: true, action: { label: "Navegador", run: () => window.print() } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <IconButton
      icon={printer.status === "connected" || printer.status === "printing" ? "print_connect" : "print"}
      label={printer.name ? `Imprimir nota en ${printer.name}` : "Imprimir nota"}
      onClick={run}
      disabled={busy}
    />
  );
}

/** Same ticket for the browser print dialog (USB/Wi-Fi printers, PDF). */
export function BrowserReceipt({ bundle, link }: { bundle: ReceiptBundle; link: string }) {
  const { tenantId, settings } = useTenant();
  const q = useQuery(extrasQuery(tenantId, bundle.order));
  if (!q.data) return null;
  return <ReceiptPreview doc={toDoc(bundle, q.data, settings, link)} width={printerPrefs().width} className="print-only" />;
}

export function ReceiptPreview({ doc, width, className }: { doc: ReceiptDoc; width: PaperWidth; className?: string }) {
  return (
    <div className={className} style={className === "print-only" ? { display: "none" } : undefined}>
      {className === "print-only" && (
        <style>{`@media print { .print-only { display: block !important; position: fixed; inset: 0; background: #fff; padding: 8px; color: #000; } .content > *:not(.print-only) { display: none !important; } @page { margin: 4mm; } }`}</style>
      )}
      <pre className="receipt" style={{ minWidth: `${width}ch` }}>
        {layout(doc, width).map((l, i) =>
          "qr" in l ? (
            <div key={i} style={{ textAlign: "center" }}>
              [QR] {l.qr}
            </div>
          ) : (
            <div key={i} style={{ textAlign: l.center ? "center" : "left", fontWeight: l.bold ? 700 : 400, fontSize: l.big ? "1.6em" : undefined }}>
              {l.text || " "}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}
