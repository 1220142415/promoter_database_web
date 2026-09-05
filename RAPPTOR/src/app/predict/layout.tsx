import { PredictionAuthGate } from '@/features/auth/auth-ui';

export default function PredictionLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <PredictionAuthGate>{children}</PredictionAuthGate>;
}
