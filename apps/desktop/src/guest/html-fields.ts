import type { GuestField } from "./recovery-contract.ts";

import { recoveryInputTypes, sensitiveField } from "./recovery-contract.ts";
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
function identifier(field: Field) {
  for (const attribute of ["id", "name", "aria-label"]) {
    const value = field.getAttribute(attribute);
    if (value) return `${attribute}:${value}`;
  }
  return undefined;
}
export function recoverableFields(document: Document) {
  const elements = [...document.querySelectorAll<Field>("input,textarea,select")];
  const result = new Map<string, Field>();
  const counts = new Map<string, number>();
  for (const element of elements) {
    const key = identifier(element);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const field of elements) {
    const key = identifier(field);
    const autocomplete =
      field.getAttribute("autocomplete") ?? field.form?.getAttribute("autocomplete");
    if (
      !key ||
      key.length > 512 ||
      counts.get(key) !== 1 ||
      sensitiveField.test(`${key} ${field.getAttribute("name") ?? ""} ${field.id}`) ||
      field.closest('[data-scope-recovery="off"]') ||
      (autocomplete && !["off", "on"].includes(autocomplete)) ||
      (field.tagName === "INPUT" && !recoveryInputTypes.includes(field.type))
    )
      continue;
    result.set(key, field);
  }
  return result;
}
export function captureField(key: string, field: Field): GuestField {
  const selected =
    field.tagName === "SELECT"
      ? [...(field as HTMLSelectElement).selectedOptions].map((option) => option.value)
      : undefined;
  if (
    field.value.length > 8192 ||
    selected?.some((value) => value.length > 8192) ||
    (selected?.length ?? 0) > 64
  )
    throw new Error("This field exceeds recovery limits. Copy its value before closing Scope.");
  return {
    key,
    tag: field.tagName.toLowerCase() as GuestField["tag"],
    type: field.type,
    value: field.value,
    ...(field.tagName === "INPUT" && ["checkbox", "radio"].includes(field.type)
      ? { checked: (field as HTMLInputElement).checked }
      : {}),
    ...(selected ? { selected } : {}),
  };
}
export function restoreFields(document: Document, values: readonly GuestField[]) {
  const fields = recoverableFields(document);
  for (const value of values) {
    const field = fields.get(value.key);
    if (!field || field.tagName.toLowerCase() !== value.tag || field.type !== value.type)
      throw new Error("Saved fields no longer match uniquely. Copy the retained input instead.");
    if (
      field.tagName === "SELECT" &&
      value.selected?.some(
        (value) =>
          ![...(field as HTMLSelectElement).options].some((option) => option.value === value),
      )
    )
      throw new Error("Saved choices no longer exist. Copy the retained input instead.");
  }
  // Assign values only. Do not dispatch authored handlers or submit a form.
  for (const value of values) {
    const field = fields.get(value.key)!;
    if (value.checked !== undefined) (field as HTMLInputElement).checked = value.checked;
    else if (field.tagName === "SELECT")
      for (const option of (field as HTMLSelectElement).options)
        option.selected = value.selected?.includes(option.value) ?? false;
    else field.value = value.value;
  }
}
