import ConstructionRoundedIcon from '@mui/icons-material/ConstructionRounded';

export default function ReleaseState({ message }: { message: string }) {
  return (
    <main className="portal-shell portal-state-page">
      <div className="portal-state-icon" aria-hidden="true"><ConstructionRoundedIcon /></div>
      <p className="portal-kicker">Release unavailable</p>
      <h1>Data release not built</h1>
      <p>{message}</p>
    </main>
  );
}
