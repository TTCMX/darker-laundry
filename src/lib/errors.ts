// Database and API errors come in English (they are for developers); the
// UI shows them in Spanish.

const MESSAGES: [RegExp, string][] = [
  [/missing permission|forbidden|not your|only an owner|only a manager|only dispatch/i, "No tienes permiso para esta acción."],
  [/authentication required|invalid session|jwt/i, "Tu sesión expiró. Vuelve a iniciar sesión."],
  [/invalid status change/i, "Ese cambio de estado no está permitido."],
  [/the step is assigned to someone else/i, "Esta fase está asignada a otra persona."],
  [/take the step before/i, "Primero toma la fase."],
  [/previous steps are not finished/i, "Termina primero las fases anteriores."],
  [/production steps are still pending/i, "Aún hay fases de producción pendientes."],
  [/not in production/i, "La orden no está en producción."],
  [/amount exceeds the balance/i, "El monto supera el saldo pendiente."],
  [/amount must be positive/i, "El monto debe ser mayor a cero."],
  [/order is not ready for delivery/i, "La orden aún no está lista para entregarse."],
  [/a failure reason is required/i, "Indica el motivo."],
  [/cannot go backwards/i, "La parada no puede regresar a un estado anterior."],
  [/a valid customer address is required/i, "Selecciona una dirección del cliente."],
  [/the order was already received/i, "La orden ya fue recibida."],
  [/duplicate key.*customers_phone|customers_phone/i, "Ya existe un cliente con ese teléfono."],
  [/invalid phone/i, "El teléfono no es válido."],
  [/deliveries_one_active/i, "Ya hay una parada activa de ese tipo para esta orden."],
  [/this address is already taken|tenants_slug/i, "Esa dirección web ya está en uso."],
  [/add the order items before production/i, "Captura los servicios de la orden antes de enviarla a producción."],
  [/no production workflow/i, "Configura un flujo de producción en Configuración."],
  [/below the minimum/i, "La orden no alcanza el mínimo para entrega."],
  [/at least one active owner/i, "El negocio debe conservar al menos un dueño activo."],
  [/the role still has members/i, "El rol todavía tiene miembros."],
  [/online payments are not configured/i, "Los pagos en línea no están configurados."],
  [/no balance/i, "La orden no tiene saldo pendiente."],
  [/invitation is no longer valid/i, "La invitación ya no es válida."],
  [/another email address/i, "Esta invitación es para otro correo."],
  [/Invalid login credentials/i, "Correo o contraseña incorrectos."],
  [/Email not confirmed/i, "Confirma tu correo antes de entrar."],
  [/User already registered/i, "Ya existe una cuenta con ese correo."],
  [/Password should be at least/i, "La contraseña debe tener al menos 6 caracteres."],
  [/Failed to fetch|NetworkError/i, "Sin conexión. Revisa tu internet e intenta de nuevo."],
];

export function errorMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err ?? "");
  for (const [re, msg] of MESSAGES) if (re.test(raw)) return msg;
  return raw || "Algo salió mal.";
}
