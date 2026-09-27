import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ORDER_STATUS_LABEL, type OrderStatus } from "../../domain/orders";
import { errorMessage } from "../../lib/errors";
import { dateTime } from "../../lib/format";
import { addOrderPhotos, signedUrls, useMemberNames } from "../../lib/queries";
import { useAuth, useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import { Button, Empty, Icon, IconButton, Loading, useToast } from "../../ui/components";

export interface OrderPhotoRow {
  id: string;
  path: string;
  caption: string | null;
  order_status: OrderStatus | null;
  step_name: string | null;
  delivery_id: string | null;
  taken_by: string | null;
  created_at: string;
}

interface GalleryPhoto {
  key: string;
  path: string;
  label: string;
  by: string | null;
  at: string | null;
  caption: string | null;
  photoId?: string;
  takenBy?: string | null;
}

export function useOrderPhotos(orderId: string) {
  return useQuery({
    queryKey: ["order-photos", orderId],
    queryFn: async () => {
      const { data, error } = await supabase.from("order_photos").select("*").eq("order_id", orderId).order("created_at");
      if (error) throw error;
      return data as OrderPhotoRow[];
    },
  });
}

/**
 * Camera / gallery picker that attaches photos to an order in one tap. Used on
 * the order page, the production board and the courier app.
 */
export function AddPhotoButton({
  orderId,
  stepId,
  deliveryId,
  compact,
  label = "Agregar fotos",
  onAdded,
}: {
  orderId: string;
  stepId?: string | null;
  deliveryId?: string | null;
  compact?: boolean;
  label?: string;
  onAdded?: () => void;
}) {
  const { tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const n = await addOrderPhotos(tenantId, orderId, files, { stepId, deliveryId });
      qc.invalidateQueries({ queryKey: ["order-photos", orderId] });
      qc.invalidateQueries({ queryKey: ["board"] });
      qc.invalidateQueries({ queryKey: ["courier"] });
      toast.show(n === 1 ? "Foto agregada" : `${n} fotos agregadas`);
      onAdded?.();
    } catch (err) {
      toast.show(`No se pudo subir: ${errorMessage(err)}`, { error: true });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => onFiles([...(e.target.files ?? [])])}
      />
      {compact ? (
        <button
          type="button"
          className="icon-btn"
          style={{ width: 32, height: 32 }}
          title="Agregar foto"
          aria-label="Agregar foto"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? <span className="spinner sm" /> : <Icon name="add_a_photo" size="sm" />}
        </button>
      ) : (
        <Button variant="tonal" icon="add_a_photo" loading={busy} onClick={() => input.current?.click()}>
          {label}
        </Button>
      )}
    </>
  );
}

/**
 * Every photo of the order in one place: photos added at any stage, proof of
 * pickup/delivery and quality-issue evidence.
 */
export function OrderPhotoGallery({
  orderId,
  extra = [],
}: {
  orderId: string;
  extra?: { path: string; label: string; at: string | null; by: string | null }[];
}) {
  const { user } = useAuth();
  const { can } = useTenant();
  const name = useMemberNames();
  const qc = useQueryClient();
  const toast = useToast();
  const photos = useOrderPhotos(orderId);
  const [open, setOpen] = useState<number | null>(null);

  const items: GalleryPhoto[] = [
    ...(photos.data ?? []).map((p) => ({
      key: p.id,
      path: p.path,
      label: p.step_name ?? (p.order_status ? ORDER_STATUS_LABEL[p.order_status] : "Orden"),
      by: p.taken_by,
      at: p.created_at,
      caption: p.caption,
      photoId: p.id,
      takenBy: p.taken_by,
    })),
    ...extra.map((e, i) => ({ key: `x${i}-${e.path}`, path: e.path, label: e.label, by: e.by, at: e.at, caption: null })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const urls = useQuery({
    queryKey: ["photo-urls", items.map((i) => i.path).join("|")],
    enabled: items.length > 0,
    staleTime: 30 * 60_000,
    queryFn: () => signedUrls(items.map((i) => i.path)),
  });

  const remove = async (id: string) => {
    const { error } = await supabase.from("order_photos").delete().eq("id", id);
    if (error) return toast.show(errorMessage(error), { error: true });
    setOpen(null);
    qc.invalidateQueries({ queryKey: ["order-photos", orderId] });
  };

  if (photos.isLoading) return <Loading />;
  if (!items.length) {
    return (
      <Empty icon="photo_camera" title="Sin fotos">
        Toma fotos al recibir la ropa, en cada fase o al entregar: quedan guardadas con la etapa y quién las tomó.
      </Empty>
    );
  }
  const current = open !== null ? items[open] : null;
  return (
    <>
      <div className="photo-grid">
        {items.map((p, i) => (
          <button key={p.key} type="button" className="photo-tile" onClick={() => setOpen(i)}>
            {urls.data?.[p.path] ? <img src={urls.data[p.path]} alt="" loading="lazy" /> : <span className="spinner sm" />}
            <span className="photo-label">{p.label}</span>
          </button>
        ))}
      </div>
      {current && (
        <div className="scrim" onClick={() => setOpen(null)}>
          <div className="lightbox" onClick={(e) => e.stopPropagation()}>
            {urls.data?.[current.path] && <img src={urls.data[current.path]} alt="" />}
            <div className="row between wrap" style={{ padding: "12px 4px 0" }}>
              <div>
                <div className="title-s">{current.label}</div>
                <div className="body-s muted">
                  {dateTime(current.at)} · {current.by ? name(current.by) : ""}
                </div>
                {current.caption && <div className="body-m">{current.caption}</div>}
              </div>
              <div className="row">
                <IconButton icon="chevron_left" label="Anterior" disabled={open === 0} onClick={() => setOpen((o) => (o ?? 0) - 1)} />
                <IconButton icon="chevron_right" label="Siguiente" disabled={open === items.length - 1} onClick={() => setOpen((o) => (o ?? 0) + 1)} />
                {urls.data?.[current.path] && (
                  <a className="icon-btn" href={urls.data[current.path]} target="_blank" rel="noreferrer" title="Abrir original">
                    <Icon name="open_in_new" />
                  </a>
                )}
                {current.photoId && (current.takenBy === user?.id || can("orders.edit")) && (
                  <IconButton icon="delete" label="Eliminar foto" onClick={() => remove(current.photoId!)} />
                )}
                <IconButton icon="close" label="Cerrar" onClick={() => setOpen(null)} />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
