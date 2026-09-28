import { newPracticeKey, practiceKeys, type PracticeKeys } from "./crypto";
import { prisma } from "./db";

export async function createPractice(input: { name: string; state: string; isSynthetic?: boolean }) {
  const { wrapped } = await newPracticeKey();
  return prisma().practice.create({
    data: { name: input.name, state: input.state.toUpperCase(), dataKeyWrapped: wrapped, isSynthetic: !!input.isSynthetic },
  });
}

export async function keysFor(practiceId: string): Promise<PracticeKeys> {
  const p = await prisma().practice.findUniqueOrThrow({ where: { id: practiceId }, select: { dataKeyWrapped: true } });
  return practiceKeys(practiceId, p.dataKeyWrapped);
}
