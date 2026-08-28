import 'server-only';

export function experimentalTssPublicEnabled(
  value = process.env.RAPPTOR_EXPERIMENTAL_TSS_PUBLIC_PAGE ?? 'on',
) {
  return value?.trim().toLowerCase() === 'on';
}
