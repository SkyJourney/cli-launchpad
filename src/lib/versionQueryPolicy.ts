export function shouldQueryLatestVersion(
  executionTasksLoading: boolean,
  hasActiveExecution: boolean,
) {
  return !executionTasksLoading && !hasActiveExecution;
}
