import type { BoothPhase, IssuedSession } from "../shared/contracts.js";

const CAPTURE_COUNT = 6;
const SELECTION_COUNT = 4;

export interface CapturedPhoto {
  id: string;
  blob: Blob;
  previewUrl: string;
}

export interface BoothState {
  phase: BoothPhase;
  generation: number;
  photos: CapturedPhoto[];
  selectedIds: string[];
  selectedFrameId: string | null;
  pendingSessionId: string | null;
  issuedSession: IssuedSession | null;
  errorMessage: string | null;
}

export type BoothEvent =
  | { type: "PREFLIGHT_SUCCEEDED"; generation: number }
  | { type: "PREFLIGHT_FAILED"; generation: number; message: string }
  | { type: "EXPERIENCE_STARTED" }
  | { type: "PHOTO_CAPTURED"; generation: number; photo: CapturedPhoto }
  | { type: "PHOTO_TOGGLED"; id: string }
  | { type: "SELECTION_CLEARED" }
  | { type: "SELECTION_CONFIRMED" }
  | { type: "FRAME_SELECTED"; id: string }
  | { type: "FRAME_CONFIRMED" }
  | { type: "PENDING_SESSION_CREATED"; generation: number; id: string }
  | { type: "CAPTURE_FAILED"; generation: number; message: string }
  | { type: "DELIVERY_SUCCEEDED"; generation: number; issued: IssuedSession }
  | { type: "DELIVERY_FAILED"; generation: number; message: string }
  | { type: "DELIVERY_RETRY_REQUESTED" }
  | { type: "RESET_CONFIRMED" };

export function initialBoothState(): BoothState {
  return {
    phase: "preflight",
    generation: 0,
    photos: [],
    selectedIds: [],
    selectedFrameId: null,
    pendingSessionId: null,
    issuedSession: null,
    errorMessage: null,
  };
}

export function boothReducer(state: BoothState, event: BoothEvent): BoothState {
  switch (event.type) {
    case "PREFLIGHT_SUCCEEDED":
      return matchesGeneration(state, event) && state.phase === "preflight"
        ? { ...state, phase: "welcome", errorMessage: null }
        : state;

    case "PREFLIGHT_FAILED":
      return matchesGeneration(state, event) && state.phase === "preflight"
        ? { ...state, phase: "error", errorMessage: event.message }
        : state;

    case "EXPERIENCE_STARTED":
      return state.phase === "welcome"
        ? { ...state, phase: "capturing", errorMessage: null }
        : state;

    case "PHOTO_CAPTURED":
      if (
        state.phase !== "capturing" ||
        !matchesGeneration(state, event) ||
        state.photos.length >= CAPTURE_COUNT ||
        state.photos.some((photo) => photo.id === event.photo.id)
      ) {
        return state;
      }

      return {
        ...state,
        phase: state.photos.length + 1 === CAPTURE_COUNT ? "selecting" : "capturing",
        photos: [...state.photos, event.photo],
      };

    case "PHOTO_TOGGLED":
      if (state.phase !== "selecting" || !hasPhoto(state, event.id)) {
        return state;
      }

      if (state.selectedIds.includes(event.id)) {
        return {
          ...state,
          selectedIds: state.selectedIds.filter((id) => id !== event.id),
        };
      }

      return state.selectedIds.length >= SELECTION_COUNT
        ? state
        : { ...state, selectedIds: [...state.selectedIds, event.id] };

    case "SELECTION_CLEARED":
      return state.phase === "selecting" && state.selectedIds.length > 0
        ? { ...state, selectedIds: [] }
        : state;

    case "SELECTION_CONFIRMED":
      return state.phase === "selecting" && state.selectedIds.length === SELECTION_COUNT
        ? { ...state, phase: "framing" }
        : state;

    case "FRAME_SELECTED":
      return state.phase === "framing" && event.id.length > 0
        ? { ...state, selectedFrameId: event.id }
        : state;

    case "FRAME_CONFIRMED":
      return state.phase === "framing" &&
        state.selectedIds.length === SELECTION_COUNT &&
        state.selectedFrameId !== null
        ? { ...state, phase: "delivering", errorMessage: null }
        : state;

    case "PENDING_SESSION_CREATED":
      return matchesGeneration(state, event) && state.phase === "delivering"
        ? { ...state, pendingSessionId: event.id }
        : state;

    case "CAPTURE_FAILED":
      return matchesGeneration(state, event) && state.phase === "capturing"
        ? { ...state, phase: "error", errorMessage: event.message }
        : state;

    case "DELIVERY_SUCCEEDED":
      return matchesGeneration(state, event) && state.phase === "delivering"
        ? {
            ...state,
            phase: "qr",
            photos: [],
            selectedIds: [],
            selectedFrameId: null,
            pendingSessionId: null,
            issuedSession: event.issued,
            errorMessage: null,
          }
        : state;

    case "DELIVERY_FAILED":
      return matchesGeneration(state, event) && state.phase === "delivering"
        ? { ...state, phase: "error", errorMessage: event.message }
        : state;

    case "DELIVERY_RETRY_REQUESTED":
      return state.phase === "error" &&
        state.selectedIds.length === SELECTION_COUNT &&
        state.selectedFrameId !== null
        ? { ...state, phase: "delivering", errorMessage: null }
        : state;

    case "RESET_CONFIRMED":
      return { ...initialBoothState(), generation: state.generation + 1 };

    default:
      return assertNever(event);
  }
}

function matchesGeneration(state: BoothState, event: { generation: number }): boolean {
  return state.generation === event.generation;
}

function hasPhoto(state: BoothState, id: string): boolean {
  return state.photos.some((photo) => photo.id === id);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled booth event: ${JSON.stringify(value)}`);
}
