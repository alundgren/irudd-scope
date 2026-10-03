import type { Actor } from "../contracts.ts";

export const fakeUsers: readonly Actor[] = [
  { id: "fake-user-alex", name: "Alex", kind: "human" },
  { id: "fake-user-blair", name: "Blair", kind: "human" },
  { id: "fake-user-casey", name: "Casey", kind: "human" },
];

export function selectedFakeUser(): Actor {
  return {
    ...(fakeUsers.find((user) => user.id === sessionStorage.getItem("scope-plan-web-user")) ??
      fakeUsers[0]),
  };
}
