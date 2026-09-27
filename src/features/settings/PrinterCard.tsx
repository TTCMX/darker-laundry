import { useState } from "react";
import { errorMessage } from "../../lib/errors";
import {
  bluetoothSupported,
  connectPrinter,
  disconnectPrinter,
  isCancelled,
  printBytes,
  printerPrefs,
  savePrinterPrefs,
  unsupportedMessage,
  usePrinter,
} from "../../lib/printing/bluetooth";
import { buildReceipt, type PaperWidth, type ReceiptDoc } from "../../lib/printing/escpos";
import { Badge, Banner, Button, Card, Segmented, useToast } from "../../ui/components";

const STATUS_LABEL = { unsupported: "No disponible", disconnected: "Sin conectar", connecting: "Conectando…", connected: "Conectada", printing: "Imprimiendo…" };

/** Printer of this phone/computer: Bluetooth pairing, paper width and a test print. */
export function PrinterCard({ sample, onWidth }: { sample: ReceiptDoc; onWidth: (w: PaperWidth) => void }) {
  const printer = usePrinter();
  const toast = useToast();
  const [width, setWidth] = useState<PaperWidth>(printerPrefs().width);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.show(ok);
    } catch (err) {
      if (!isCancelled(err)) toast.show(errorMessage(err), { error: true });
    } finally {
      setBusy(false);
    }
  };
  const connected = printer.status === "connected" || printer.status === "printing";
  return (
    <Card title="Impresora de este dispositivo">
      <div className="col gap-16">
        <p className="body-m muted" style={{ margin: 0 }}>
          Impresoras térmicas Bluetooth (58 u 80 mm). Cada celular o computadora conecta la suya; la conexión se mantiene mientras la app esté abierta y
          se retoma sola al imprimir.
        </p>
        {!bluetoothSupported() && <Banner tone="warning">{unsupportedMessage()}</Banner>}
        <div className="row between wrap gap-12">
          <div className="row gap-8">
            <span className="title-s">{printer.name ?? "Ninguna impresora"}</span>
            <Badge tone={connected ? "success" : "neutral"}>{STATUS_LABEL[printer.status]}</Badge>
          </div>
          <div className="row wrap gap-8">
            {connected ? (
              <Button variant="text" icon="link_off" onClick={disconnectPrinter}>
                Desconectar
              </Button>
            ) : (
              <>
                <Button variant="text" onClick={() => run(() => connectPrinter({ anyDevice: true }), "Impresora conectada")} disabled={!bluetoothSupported() || busy}>
                  Mostrar todos los dispositivos
                </Button>
                <Button icon="bluetooth" onClick={() => run(() => connectPrinter(), "Impresora conectada")} disabled={!bluetoothSupported()} loading={busy}>
                  Conectar
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="col gap-8">
          <span className="body-m">Ancho del papel</span>
          <Segmented
            value={String(width) as "32" | "48"}
            onChange={(v) => {
              const w = Number(v) as PaperWidth;
              setWidth(w);
              savePrinterPrefs({ width: w });
              onWidth(w);
            }}
            options={[
              { value: "32", label: "58 mm" },
              { value: "48", label: "80 mm" },
            ]}
          />
        </div>
        <div className="row end">
          <Button variant="tonal" icon="print" onClick={() => run(() => printBytes(buildReceipt(sample, width)), "Prueba enviada")} disabled={!bluetoothSupported()} loading={busy && connected}>
            Imprimir prueba
          </Button>
        </div>
      </div>
    </Card>
  );
}
