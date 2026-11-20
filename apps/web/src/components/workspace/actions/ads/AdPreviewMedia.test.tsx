import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../managed-campaigns/api", () => ({ campaignFetch: fetchMock }));
vi.mock("next/image", () => ({ default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} /> }));

import { AdPreviewMedia } from "./AdPreviewMedia";

const ARTIFACT = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe("AdPreviewMedia for a Zavi-generated image", () => {
  it("signs the artifact and shows the picture", async () => {
    fetchMock.mockResolvedValue({ signed_url: "https://storage.test/signed.png" });
    render(<AdPreviewMedia creative={{ title: "Rent a car", media_kind: "image", image_artifact_id: ARTIFACT }} format="feed" imageShape="reddit" />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Rent a car" }).getAttribute("src")).toBe("https://storage.test/signed.png"));
    expect(fetchMock).toHaveBeenCalledWith(`/api/run-artifacts/${ARTIFACT}/url`);
  });

  it("says the media could not be loaded when signing fails", async () => {
    fetchMock.mockRejectedValue(new Error("403"));
    render(<AdPreviewMedia creative={{ title: "Rent a car", media_kind: "image", image_artifact_id: ARTIFACT }} format="feed" />);
    await waitFor(() => expect(screen.getByText("This media could not be loaded.")).toBeTruthy());
  });

  it("never asks for an artifact when the creative already has a link", async () => {
    render(<AdPreviewMedia creative={{ title: "Rent a car", image_url: "https://x.test/a.png", image_artifact_id: ARTIFACT }} format="feed" />);
    expect(screen.getByRole("img", { name: "Rent a car" }).getAttribute("src")).toBe("https://x.test/a.png");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
