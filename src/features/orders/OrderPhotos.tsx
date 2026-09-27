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
const labelOf = (p: OrderPhotoRow) => p.step_name ?? (p.order_status ? ORDER_STATUS_LABEL[p.order_status] : "Orden");

const toItems = (rows: OrderPhotoRow[]): GalleryPhoto[] =>
  rows.map((p) => ({
    key: p.id,
    path: p.path,
    label: labelOf(p),
    by: p.taken_by,
    at: p.created_at,
    caption: p.caption,
    photoId: p.id,
    takenBy: p.taken_by,
  }));

function usePhotoUrls(paths: string[]) {
  return useQuery({
    queryKey: ["photo-urls", paths.join("|")],
    enabled: paths.length > 0,
    staleTime: 30 * 60_000,
    queryFn: () => signedUrls(paths),
  });
}

/** Full-screen viewer with previous/next, open original and delete. */
function PhotoLightbox({
  items,
  urls,
  index,
  onIndex,
  onDeleted,
}: {
  items: GalleryPhoto[];
  urls: Record<string, string> | undefined;
  index: number;
  onIndex: (i: number | null) => void;
  onDeleted: () => void;
}) {
  const { user } = useAuth();
  const { can } = useTenant();
  const name = useMemberNames();
  const toast = useToast();
  const current = items[index];
  if (!current) return null;
  const remove = async (id: string) => {
    const { error } = await supabase.from("order_photos").delete().eq("id", id);
    if (error) return toast.show(errorMessage(error), { error: true });
    onIndex(null);
    onDeleted();
  };
  return (
    <div className="scrim" onClick={() => onIndex(null)}>
      <div className="lightbox" onClick={(e) => e.stopPropagation()}>
        {urls?.[current.path] ? <img src={urls[current.path]} alt="" /> : <Loading />}
        <div className="row between wrap" style={{ padding: "12px 4px 0" }}>
          <div>
            <div className="title-s">{current.label}</div>
            <div className="body-s muted">
              {dateTime(current.at)} · {current.by ? name(current.by) : ""}
            </div>
            {current.caption && <div className="body-m">{current.caption}</div>}
          </div>
          <div className="row">
            <IconButton icon="chevron_left" label="Anterior" disabled={index === 0} onClick={() => onIndex(index - 1)} />
            <IconButton icon="chevron_right" label="Siguiente" disabled={index === items.length - 1} onClick={() => onIndex(index + 1)} />
            {urls?.[current.path] && (
              <a className="icon-btn" href={urls[current.path]} target="_blank" rel="noreferrer" title="Abrir original">
                <Icon name="open_in_new" />
              </a>
            )}
            {current.photoId && (current.takenBy === user?.id || can("orders.edit")) && (
              <IconButton icon="delete" label="Eliminar foto" onClick={() => remove(current.photoId!)} />
            )}
            <IconButton icon="close" label="Cerrar" onClick={() => onIndex(null)} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small thumbnails for cards (production board): tap to see them full size. */
export function PhotoStrip({ orderId, photos, max = 3 }: { orderId: string; photos: OrderPhotoRow[]; max?: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const items = toItems([...photos].sort((a, b) => a.created_at.localeCompare(b.created_at)));
  const shown = items.slice(-max);
  const urls = usePhotoUrls(items.map((i) => i.path));
  if (!items.length) return null;
  const hidden = items.length - shown.length;
  return (
    <>
      <div className="photo-strip">
        {shown.map((p, i) => (
          <button
            key={p.key}
            type="button"
            className="photo-thumb"
            title={p.label}
            onClick={() => setOpen(items.length - shown.length + i)}
          >
            {urls.data?.[p.path] ? <img src={urls.data[p.path]} alt="" loading="lazy" /> : <span className="spinner sm" />}
            {i === 0 && hidden > 0 && <span className="photo-more">+{hidden}</span>}
          </button>
        ))}
      </div>
      {open !== null && (
        <PhotoLightbox
          items={items}
          urls={urls.data}
          index={open}
          onIndex={setOpen}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ["board"] });
            qc.invalidateQueries({ queryKey: ["order-photos", orderId] });
          }}
        />
      )}
    </>
  );
}

export function OrderPhotoGallery({
  orderId,
  extra = [],
}: {
  orderId: string;
  extra?: { path: string; label: string; at: string | null; by: string | null }[];
}) {
  const qc = useQueryClient();
  const photos = useOrderPhotos(orderId);
  const [open, setOpen] = useState<number | null>(null);

  const items: GalleryPhoto[] = [
    ...toItems(photos.data ?? []),
    ...extra.map((e, i) => ({ key: `x${i}-${e.path}`, path: e.path, label: e.label, by: e.by, at: e.at, caption: null })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const urls = usePhotoUrls(items.map((i) => i.path));

  if (photos.isLoading) return <Loading />;
  if (!items.length) {
    return (
      <Empty icon="photo_camera" title="Sin fotos">
        Toma fotos al recibir la ropa, en cada fase o al entregar: quedan guardadas con la etapa y quién las tomó.
      </Empty>
    );
  }
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
      {open !== null && (
        <PhotoLightbox
          items={items}
          urls={urls.data}
          index={open}
          onIndex={setOpen}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ["order-photos", orderId] });
            qc.invalidateQueries({ queryKey: ["board"] });
          }}
        />
      )}
    </>
  );
}
