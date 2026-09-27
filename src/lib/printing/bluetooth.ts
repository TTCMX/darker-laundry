// Web Bluetooth transport for BLE thermal printers (Chrome/Edge on Android,
// Windows, macOS and ChromeOS). Same protocol as the laundry's internal app:
// service 0x18F0 / characteristic 0x2AF1, 100-byte chunks with a 100 ms pause
// so the printer's buffer never overflows. Other common printer services are
// tried as a fallback.

import { useSyncExternalStore } from "react";
import type { PaperWidth } from "./escpos";

// Minimal Web Bluetooth typings (not in lib.dom).
interface BtCharacteristic {
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValueWithoutResponse(data: BufferSource): Promise<void>;
  writeValueWithResponse(data: BufferSource): Promise<void>;
}
interface BtService {
  getCharacteristic(uuid: string): Promise<BtCharacteristic>;
  getCharacteristics(): Promise<BtCharacteristic[]>;
}
interface BtServer {
  connected: boolean;
  connect(): Promise<BtServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BtService>;
}
interface BtDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BtServer;
}
interface BtApi {
  requestDevice(options: unknown): Promise<BtDevice>;
}

const uuid16 = (n: number) => `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;

/** Known printer services and their write characteristic, most common first. */
const PROFILES: { service: string; characteristic: string }[] = [
  { service: uuid16(0x18f0), characteristic: uuid16(0x2af1) },
  { service: "e7810a71-73ae-499d-8c15-faa9aef0c3f2", characteristic: "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f" },
  { service: "49535343-fe7d-4ae5-8fa9-9fafd205e455", characteristic: "49535343-8841-43f4-a8d4-ecbe34729bb3" },
  { service: uuid16(0xff00), characteristic: uuid16(0xff02) },
  { service: uuid16(0xffe0), characteristic: uuid16(0xffe1) },
];

const NAME_PREFIXES = ["IM.15", "Ele", "MTP", "BT", "Printer", "PT-", "MPT", "RPP", "POS", "XP-", "GP-"];

const CHUNK = 100;
const PAUSE_MS = 100;

export type PrinterStatus = "unsupported" | "disconnected" | "connecting" | "connected" | "printing";

interface State {
  status: PrinterStatus;
  name: string | null;
}

const bluetooth = (): BtApi | undefined => (typeof navigator !== "undefined" ? (navigator as Navigator & { bluetooth?: BtApi }).bluetooth : undefined);

export const bluetoothSupported = () => !!bluetooth();

let device: BtDevice | null = null;
let characteristic: BtCharacteristic | null = null;
let state: State = { status: bluetoothSupported() ? "disconnected" : "unsupported", name: null };
const listeners = new Set<() => void>();
const setState = (s: Partial<State>) => {
  state = { ...state, ...s };
  listeners.forEach((l) => l());
};

export const printerStatus = () => state.status;

export function usePrinter(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// Per-device preferences: each phone/computer has its own printer.
const PREFS_KEY = "dlos:printer";
export interface PrinterPrefs {
  width: PaperWidth;
}
export function printerPrefs(): PrinterPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { width: p.width === 48 ? 48 : 32 };
  } catch {
    return { width: 32 };
  }
}
export function savePrinterPrefs(p: PrinterPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Private mode: keep the default.
  }
}

async function findCharacteristic(server: BtServer): Promise<BtCharacteristic> {
  for (const p of PROFILES) {
    let service: BtService;
    try {
      service = await server.getPrimaryService(p.service);
    } catch {
      continue;
    }
    try {
      return await service.getCharacteristic(p.characteristic);
    } catch {
      const writable = (await service.getCharacteristics().catch(() => [])).find((c) => c.properties.writeWithoutResponse || c.properties.write);
      if (writable) return writable;
    }
  }
  throw new Error("La impresora no expone un servicio de impresión compatible.");
}

async function attach(d: BtDevice) {
  if (!d.gatt) throw new Error("El dispositivo no admite conexión Bluetooth LE.");
  setState({ status: "connecting", name: d.name ?? "Impresora" });
  try {
    const server = await d.gatt.connect();
    characteristic = await findCharacteristic(server);
    if (device !== d) {
      d.addEventListener("gattserverdisconnected", () => {
        characteristic = null;
        if (device === d) setState({ status: "disconnected" });
      });
    }
    device = d;
    setState({ status: "connected", name: d.name ?? "Impresora" });
  } catch (err) {
    characteristic = null;
    setState({ status: "disconnected", name: device?.name ?? null });
    throw err;
  }
}

/**
 * Opens the browser's device chooser. Must run from a click. `anyDevice` lists
 * every nearby device, for printers whose name we don't recognise.
 */
export async function connectPrinter({ anyDevice = false } = {}) {
  const bt = bluetooth();
  if (!bt) throw new Error(unsupportedMessage());
  const optionalServices = PROFILES.map((p) => p.service);
  const d = await bt.requestDevice(
    anyDevice
      ? { acceptAllDevices: true, optionalServices }
      : {
          filters: [...NAME_PREFIXES.map((namePrefix) => ({ namePrefix })), ...optionalServices.map((s) => ({ services: [s] }))],
          optionalServices,
        },
  );
  await attach(d);
}

export function disconnectPrinter() {
  const d = device;
  device = null;
  characteristic = null;
  d?.gatt?.disconnect();
  setState({ status: bluetoothSupported() ? "disconnected" : "unsupported", name: null });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends raw ESC/POS bytes. Reconnects to the last printer if it dropped, or
 * asks the user to pick one (so call it from a click).
 */
export async function printBytes(data: Uint8Array) {
  if (!characteristic || !device?.gatt?.connected) {
    if (device) await attach(device);
    else await connectPrinter();
  }
  const c = characteristic!;
  setState({ status: "printing" });
  try {
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.slice(i, i + CHUNK);
      if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(chunk);
      else await c.writeValueWithResponse(chunk);
      await sleep(PAUSE_MS);
    }
  } finally {
    setState({ status: device?.gatt?.connected ? "connected" : "disconnected" });
  }
}

export function unsupportedMessage() {
  const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  return ios
    ? "Safari en iPhone no permite Bluetooth. Abre la app en el navegador Bluefy para imprimir, o usa “Imprimir (navegador)”."
    : "Este navegador no permite Bluetooth. Usa Chrome o Edge (Android, Windows, Mac) o “Imprimir (navegador)”.";
}

/** User closed the chooser: not an error worth showing. */
export const isCancelled = (err: unknown) => err instanceof Error && err.name === "NotFoundError" && /cancel/i.test(err.message);
