export interface HarmonyDeviceLabelSource {
  serial: string;
  /** User-configured device nickname, which is not necessarily the hardware model. */
  name?: string;
  /** Certified hardware model from const.product.model, for example ALN-AL00. */
  model?: string;
  /** Market/product name from const.product.name, for example HUAWEI Mate 60 Pro. */
  product?: string;
}

function cleanPart(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function sameIdentity(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.localeCompare(right, undefined, { sensitivity: "base" }) === 0);
}

/** Keep the physical product/model primary; a user nickname is supplemental. */
export function formatHarmonyDeviceLabel(device: HarmonyDeviceLabelSource): string {
  const product = cleanPart(device.product);
  const model = cleanPart(device.model);
  const nickname = cleanPart(device.name);
  const serial = cleanPart(device.serial) ?? "Harmony device";

  const hardware = product && model && !sameIdentity(product, model)
    ? `${product} (${model})`
    : product ?? model;
  if (!hardware) return nickname ?? serial;
  if (!nickname || sameIdentity(nickname, product) || sameIdentity(nickname, model)) return hardware;
  return `${hardware} · ${nickname}`;
}
