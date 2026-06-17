export interface WorkspaceHealth {
  name: string;
  ready: boolean;
}

export function createWorkspaceHealth(name = 'kaname-relay'): WorkspaceHealth {
  return {
    name,
    ready: true,
  };
}
