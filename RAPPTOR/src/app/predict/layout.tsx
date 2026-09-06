import { PredictionAuthGate } from '@/features/email-system/auth-ui';

export default function PredictionLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <PredictionAuthGate>{children}</PredictionAuthGate>;
}
