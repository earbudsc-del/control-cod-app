import type { UserRole, TaskType } from '@/types'

export const OPERATIVE_ROLES: UserRole[] = [
  'admin',
  'ia_supervisor',
  'confirmation_agent',
  'novelty_agent',
  'delivery_agent',
  'agent',
]

export function isAgentOrAbove(role: UserRole | string | null | undefined): boolean {
  return OPERATIVE_ROLES.includes(role as UserRole)
}

// Qué task_types puede ver cada rol en /my-tasks.
// null = sin filtro de tipo (ve todos los que le asignen).
// undefined (rol no listado) se trata igual que null.
export const ROLE_TASK_TYPES: Partial<Record<string, TaskType[] | null>> = {
  confirmation_agent: ['confirmation'],
  novelty_agent:      ['novedad', 'recovery'],
  delivery_agent:     ['follow_up', 'recovery'],
  agent:              null,
  ia_supervisor:      null,
}
