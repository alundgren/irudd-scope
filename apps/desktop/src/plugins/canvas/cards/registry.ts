import { boxesCard } from "./boxes/contract.ts";

export const cardTypes = [boxesCard];
export const findCardType = (type: string) => cardTypes.find((entry) => entry.type === type);
