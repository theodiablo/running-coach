import { useEffect, useState } from "react";
import { readFollows, subscribeFollows, type FollowedRunner } from "../live/followList";

// The follow list, kept in step with writes from other tabs.
export function useFollows(): [FollowedRunner[], (list: FollowedRunner[]) => void] {
  const [list, setList] = useState(() => readFollows());
  useEffect(() => subscribeFollows(setList), []);
  return [list, setList];
}
