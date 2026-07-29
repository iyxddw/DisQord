import { z } from 'zod';

export const programKinds = ['central-server', 'qq-node', 'discord-node'] as const;
export const programKindSchema = z.enum(programKinds);
export type ProgramKind = z.infer<typeof programKindSchema>;

export const platformSchema = z.enum(['qq', 'discord']);
export type Platform = z.infer<typeof platformSchema>;

export interface ProgramDescriptor {
  readonly name: ProgramKind;
  readonly role: 'central' | 'platform-node';
  readonly platform?: Platform;
}

export function createProgramDescriptor(name: ProgramKind): ProgramDescriptor {
  switch (name) {
    case 'central-server':
      return { name, role: 'central' };
    case 'qq-node':
      return { name, role: 'platform-node', platform: 'qq' };
    case 'discord-node':
      return { name, role: 'platform-node', platform: 'discord' };
  }
}
