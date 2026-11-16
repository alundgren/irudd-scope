import { boxesCard } from "./boxes/contract.ts";
import { boxesTools } from "./boxes/tools.ts";
import type { CardTools } from "./types.ts";

export const cardTypes = [boxesCard];
export const findCardType = (type: string) => cardTypes.find((entry) => entry.type === type);

const tools: Record<string, CardTools> = { boxes: boxesTools };
/** The agent tools for a card type, if it has them. */
export const findCardTools = (type: string): CardTools | undefined => tools[type];
