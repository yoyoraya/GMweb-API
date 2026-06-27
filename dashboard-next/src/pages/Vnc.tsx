import { useRef } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const VNC_SRC = "/vnc/vnc.html?autoconnect=true&resize=scale&path=vnc/websockify";

export function VncPage() {
  const ref = useRef<HTMLIFrameElement>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>VNC console</CardTitle>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => window.open(VNC_SRC, "_blank")}>
            <ExternalLink className="size-4" /> Open
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (ref.current) ref.current.src = VNC_SRC;
            }}
          >
            <RefreshCw className="size-4" /> Reload
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <iframe ref={ref} src={VNC_SRC} title="GMweb VNC" className="h-[70vh] w-full rounded-b-xl border-0 bg-black" />
        <p className="p-3 text-xs text-muted-foreground">
          Turn VNC on from Controls first. Use it to scan the Google Messages pairing QR, then turn it off.
        </p>
      </CardContent>
    </Card>
  );
}
