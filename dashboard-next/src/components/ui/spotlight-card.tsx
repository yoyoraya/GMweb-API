import * as React from "react";
import { useMotionTemplate, useMotionValue, motion } from "framer-motion";
import { cn } from "@/lib/utils";

// cult-ui inspired: a card with a cursor-following radial spotlight + soft border
// glow. Pure CSS/motion, no extra deps beyond framer-motion.
export function SpotlightCard({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    mouseX.set(e.clientX - rect.left);
    mouseY.set(e.clientY - rect.top);
  }

  const background = useMotionTemplate`radial-gradient(220px circle at ${mouseX}px ${mouseY}px, hsl(var(--primary) / 0.12), transparent 80%)`;

  return (
    <div
      onMouseMove={onMouseMove}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className
      )}
      {...props}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-px opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
