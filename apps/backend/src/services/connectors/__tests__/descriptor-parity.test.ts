
import { describe, it, expect } from "vitest";
import {
  recommenderSlugs,
  toolPrefixToConnector,
  recommenderToolPrefixToConnector,
} from "@zavi/shared";
import {
  CONNECTOR_SLUGS,
  TOOL_PREFIX_TO_CONNECTOR as CATALOG_PREFIX_MAP,
} from "@/services/connectors/catalog";
import { TOOL_PREFIX_TO_CONNECTOR as SETUP_PREFIX_MAP } from "@/services/agents/setup-schema";

describe("connector descriptor parity (@zavi/shared is the single source of truth)", () => {
  it("recommender slugs match catalog CONNECTOR_SLUGS exactly, in order", () => {
    expect(recommenderSlugs()).toEqual([...CONNECTOR_SLUGS]);
  });

  it("descriptor full prefix map matches setup-schema TOOL_PREFIX_TO_CONNECTOR", () => {
    expect(toolPrefixToConnector()).toEqual(SETUP_PREFIX_MAP);
  });

  it("descriptor recommender-visible prefix map matches catalog TOOL_PREFIX_TO_CONNECTOR", () => {
    expect(recommenderToolPrefixToConnector()).toEqual(CATALOG_PREFIX_MAP);
  });

  it("every recommender-visible connector is also known to the setup tool-prefix map", () => {
    for (const slug of recommenderSlugs()) {
      expect(Object.values(SETUP_PREFIX_MAP)).toContain(slug);
    }
  });
});
