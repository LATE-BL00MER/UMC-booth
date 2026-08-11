import { describe, expect, it } from "vitest";

import {
  boothReducer,
  initialBoothState,
  type BoothState,
  type CapturedPhoto,
} from "../../src/operator/booth-machine.js";
import type { IssuedSession } from "../../src/shared/contracts.js";

const issuedSession: IssuedSession = {
  id: "issued-1",
  publicToken: "token",
  deliveryUrl: "https://delivery.example/d/issued-1",
  expiresAt: 1_700_000_000_000,
};

function photo(index: number): CapturedPhoto {
  return {
    id: `p${index}`,
    blob: new Blob([String(index)], { type: "image/jpeg" }),
    previewUrl: `blob:photo-${index}`,
  };
}

function capturingState(generation = 0): BoothState {
  return {
    ...initialBoothState(),
    generation,
    phase: "capturing",
  };
}

function selectingStateWithSixPhotos(): BoothState {
  let state = capturingState();
  for (let index = 1; index <= 6; index += 1) {
    state = boothReducer(state, {
      type: "PHOTO_CAPTURED",
      generation: state.generation,
      photo: photo(index),
    });
  }
  return state;
}

function deliveringState(generation: number): BoothState {
  return {
    ...initialBoothState(),
    generation,
    phase: "delivering",
    photos: [photo(1), photo(2), photo(3), photo(4), photo(5), photo(6)],
    selectedIds: ["p1", "p2", "p3", "p4"],
    selectedFrameId: "basic",
    pendingSessionId: "pending-1",
  };
}

describe("boothReducer", () => {
  it("moves to selection only after six photos", () => {
    let state = capturingState();
    for (let index = 1; index <= 5; index += 1) {
      state = boothReducer(state, {
        type: "PHOTO_CAPTURED",
        generation: state.generation,
        photo: photo(index),
      });
      expect(state.phase).toBe("capturing");
    }

    state = boothReducer(state, {
      type: "PHOTO_CAPTURED",
      generation: state.generation,
      photo: photo(6),
    });

    expect(state.phase).toBe("selecting");
  });

  it("rejects a seventh captured photo", () => {
    const complete = selectingStateWithSixPhotos();
    const result = boothReducer(complete, {
      type: "PHOTO_CAPTURED",
      generation: complete.generation,
      photo: photo(7),
    });

    expect(result).toBe(complete);
  });

  it("uses click order and renumbers after deselection", () => {
    let state = selectingStateWithSixPhotos();
    state = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p4" });
    state = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p1" });
    state = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p6" });
    state = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p1" });

    expect(state.selectedIds).toEqual(["p4", "p6"]);
  });

  it("rejects a fifth selection and an unknown photo", () => {
    let state = selectingStateWithSixPhotos();
    for (const id of ["p1", "p2", "p3", "p4"]) {
      state = boothReducer(state, { type: "PHOTO_TOGGLED", id });
    }
    const fifth = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p5" });
    const unknown = boothReducer(state, { type: "PHOTO_TOGGLED", id: "missing" });

    expect(fifth).toBe(state);
    expect(unknown).toBe(state);
  });

  it("requires exactly four selected photos before framing", () => {
    const selecting = selectingStateWithSixPhotos();
    const result = boothReducer(selecting, { type: "SELECTION_CONFIRMED", frameId: "basic" });

    expect(result).toBe(selecting);
  });

  it("opens framing with the first available frame already selected", () => {
    let selecting = selectingStateWithSixPhotos();
    for (const id of ["p4", "p1", "p6", "p3"]) {
      selecting = boothReducer(selecting, { type: "PHOTO_TOGGLED", id });
    }

    const result = boothReducer(selecting, { type: "SELECTION_CONFIRMED", frameId: "basic" });

    expect(result).toMatchObject({ phase: "framing", selectedFrameId: "basic" });
  });

  it("returns from framing to selection without losing the chosen photos", () => {
    const framing: BoothState = {
      ...selectingStateWithSixPhotos(),
      phase: "framing",
      selectedIds: ["p4", "p1", "p6", "p3"],
      selectedFrameId: "basic",
    };

    const result = boothReducer(framing, { type: "NAVIGATED_BACK" });

    expect(result).toMatchObject({
      phase: "selecting",
      selectedIds: ["p4", "p1", "p6", "p3"],
      selectedFrameId: null,
    });
    expect(result.photos).toEqual(framing.photos);
  });

  it("starts a fresh capture when returning from selection", () => {
    const selecting = selectingStateWithSixPhotos();

    const result = boothReducer(selecting, { type: "NAVIGATED_BACK" });

    expect(result).toMatchObject({
      phase: "capturing",
      generation: selecting.generation + 1,
      photos: [],
      selectedIds: [],
    });
  });

  it("returns from capture to the welcome screen", () => {
    const result = boothReducer(capturingState(3), { type: "NAVIGATED_BACK" });

    expect(result).toMatchObject({ phase: "welcome", generation: 4, photos: [] });
  });

  it("rejects frame confirmation before four selections", () => {
    const framing: BoothState = {
      ...selectingStateWithSixPhotos(),
      phase: "framing",
      selectedIds: ["p1", "p2", "p3"],
      selectedFrameId: "basic",
    };
    const result = boothReducer(framing, { type: "FRAME_CONFIRMED" });

    expect(result).toBe(framing);
  });

  it("clears current-session image state once delivery succeeds", () => {
    const delivered = boothReducer(deliveringState(4), {
      type: "DELIVERY_SUCCEEDED",
      generation: 4,
      issued: issuedSession,
    });

    expect(delivered).toMatchObject({
      phase: "qr",
      issuedSession,
      photos: [],
      selectedIds: [],
      selectedFrameId: null,
      pendingSessionId: null,
    });
  });

  it("replaces the displayed QR session when the active registry reissues it", () => {
    const delivered = boothReducer(deliveringState(4), {
      type: "DELIVERY_SUCCEEDED",
      generation: 4,
      issued: issuedSession,
    });
    const reissued = { ...issuedSession, deliveryUrl: "https://replacement.example/d/issued-1" };

    const updated = boothReducer(delivered, { type: "ISSUED_SESSION_REISSUED", issued: reissued });

    expect(updated.phase).toBe("qr");
    expect(updated.issuedSession).toEqual(reissued);
  });

  it("ignores an async result from before reset", () => {
    const reset = boothReducer(deliveringState(4), { type: "RESET_CONFIRMED" });
    const stale = boothReducer(reset, {
      type: "DELIVERY_SUCCEEDED",
      generation: 4,
      issued: issuedSession,
    });

    expect(stale.phase).toBe("preflight");
    expect(stale.issuedSession).toBeNull();
  });

  it("rejects a delivery result with a stale generation while still delivering", () => {
    const delivering = deliveringState(4);
    const stale = boothReducer(delivering, {
      type: "DELIVERY_SUCCEEDED",
      generation: 3,
      issued: issuedSession,
    });

    expect(stale).toBe(delivering);
  });

  it("reset increments generation and clears all current-session fields", () => {
    const reset = boothReducer(
      {
        ...deliveringState(4),
        issuedSession,
        errorMessage: "failed",
      },
      { type: "RESET_CONFIRMED" },
    );

    expect(reset).toEqual({ ...initialBoothState(), generation: 5 });
  });
});
