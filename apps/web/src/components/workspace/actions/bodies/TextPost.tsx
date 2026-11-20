"use client";

import { Type } from "lucide-react";
import { PostCard } from "../PostCard";
import type { ActionBodyProps } from "../types";

export function TextPost(props: ActionBodyProps) {
  return <PostCard {...props} icon={Type} />;
}
