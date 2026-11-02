import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiClientError } from "../../api/httpClient";
import { generateVectorLayers, getVectorLayers } from "../../api/vectorLayersApi";
import type { VectorLayerSetResponse } from "../../types/vectorLayers";
import { OpenWorkspaceButton } from "./OpenWorkspaceButton";

vi.mock("../../api/vectorLayersApi", () => ({ getVectorLayers: vi.fn(), generateVectorLayers: vi.fn() }));
const get = vi.mocked(getVectorLayers);
const generate = vi.mocked(generateVectorLayers);
const layers: VectorLayerSetResponse = {
  projectId: "p", imageId: "i", paletteId: "palette", paletteVersion: 2, layerSetId: "set", version: 1,
  sourceWidthPx: 476, sourceHeightPx: 307, cached: false,
  layers: [{ groupId: "color", name: "Logo", colorHex: "#482836", areaPercent: 12, hasPartialAlpha: false, vectorId: "v", svgUrl: "/vectors/v" }],
};
const props = { projectId: "p", imageId: "i", paletteId: "palette", paletteVersion: 2 };
const missing = new ApiClientError("not found", { status: 404 });
beforeEach(() => vi.resetAllMocks());

it("reuses current layers without generating or changing them", async () => {
  get.mockResolvedValue(layers);
  const ready = vi.fn();
  render(<OpenWorkspaceButton {...props} onReady={ready} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(generate).not.toHaveBeenCalled();
});

it("waits for missing layers to finish before opening and prevents duplicate clicks", async () => {
  get.mockRejectedValue(missing);
  let finish!: (value: VectorLayerSetResponse) => void;
  generate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const ready = vi.fn();
  render(<OpenWorkspaceButton {...props} onReady={ready} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(generate).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Preparando Workspace…" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button"));
  expect(ready).not.toHaveBeenCalled();
  await act(async () => finish(layers));
  expect(ready).toHaveBeenCalledOnce();
  expect(generate).toHaveBeenCalledOnce();
});

it("stays on the project after a generation failure and allows retry", async () => {
  get.mockRejectedValue(missing);
  generate.mockRejectedValueOnce(new Error("engine offline")).mockResolvedValueOnce(layers);
  const ready = vi.fn();
  render(<OpenWorkspaceButton {...props} onReady={ready} />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo preparar el Workspace");
  expect(ready).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(ready).toHaveBeenCalledOnce());
});

it.each([new ApiClientError("forbidden", { status: 403 }), new ApiClientError("offline", { isNetworkError: true })])(
  "does not generate layers after a read/auth/network failure", async error => {
    get.mockRejectedValue(error);
    const ready = vi.fn();
    render(<OpenWorkspaceButton {...props} onReady={ready} />);
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert");
    expect(generate).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  },
);

it("regenerates a set belonging to an older confirmed palette version", async () => {
  get.mockResolvedValue({ ...layers, paletteVersion: 1 });
  generate.mockResolvedValue(layers);
  const ready = vi.fn();
  render(<OpenWorkspaceButton {...props} onReady={ready} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(generate).toHaveBeenCalledOnce();
});

it("does not open an empty generated document", async () => {
  get.mockRejectedValue(missing);
  generate.mockResolvedValue({ ...layers, layers: [] });
  const ready = vi.fn();
  render(<OpenWorkspaceButton {...props} onReady={ready} />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("alert");
  expect(ready).not.toHaveBeenCalled();
});

it("ignores late completion when the user leaves or loads a different project", async () => {
  get.mockRejectedValue(missing);
  let finish!: (value: VectorLayerSetResponse) => void;
  generate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const ready = vi.fn();
  const view = render(<OpenWorkspaceButton {...props} onReady={ready} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(generate).toHaveBeenCalledOnce());
  const signal = generate.mock.calls[0][3]!;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(layers));
  expect(ready).not.toHaveBeenCalled();
});
