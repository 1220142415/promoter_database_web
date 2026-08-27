import 'server-only';

export function experimentalTssPublicEnabled(
  value = process.env.RAPPTOR_EXPERIMENTAL_TSS_PUBLIC_PAGE,
) {
  return value?.trim().toLowerCase() === 'on';
}
