const KEY = "wester-checkin.device_id";

let cached: string | null = null;

export function getDeviceId(): string {
  if (cached) return cached;
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  cached = id;
  return id;
}
