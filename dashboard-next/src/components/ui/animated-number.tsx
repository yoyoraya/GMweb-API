import { useEffect } from "react";
import { useSpring, useTransform, motion } from "framer-motion";

// cult-ui style spring-animated number. Smoothly counts to `value`.
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const spring = useSpring(value, { mass: 0.8, stiffness: 90, damping: 18 });
  const display = useTransform(spring, (current) => Math.round(current).toLocaleString());

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  return <motion.span className={className}>{display}</motion.span>;
}
