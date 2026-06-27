import { Loader2 } from "lucide-react";
import { SessionProvider, useSession } from "@/lib/session";
import { Login } from "@/components/Login";
import { Shell } from "@/components/Shell";

function Gate() {
  const { ready, authenticated } = useSession();
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return authenticated ? <Shell /> : <Login />;
}

export default function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
