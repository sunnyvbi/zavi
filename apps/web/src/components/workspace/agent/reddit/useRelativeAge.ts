import { useEffect, useState } from "react";
import { agoShort } from "./ui";

export function useRelativeAge(iso: string | null) {
  const [age, setAge] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setAge(iso ? agoShort(iso) : null);
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [iso]);
  return age;
}
