/** Чистая логика кнопок трейсера: Play/Stop переключают, Step разрешён только в стопе. */

export type PlayerAction = "play" | "stop" | "step";

export interface PlayerState {
  playing: boolean;
  stepped?: boolean;
}

export function playerControls(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action) {
    case "play":
      return { playing: true };
    case "stop":
      return { playing: false };
    case "step":
      return state.playing ? state : { playing: false, stepped: true };
  }
}
