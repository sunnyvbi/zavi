"use client";

import { createContext, useContext, type ReactNode } from "react";

const ChannelSurfaceContext = createContext<string | null>(null);
export function ChannelSurface({ slug, children }: { slug: string; children: ReactNode }) { return <ChannelSurfaceContext.Provider value={slug}>{children}</ChannelSurfaceContext.Provider>; }
export function useChannelSurface() { return useContext(ChannelSurfaceContext); }
