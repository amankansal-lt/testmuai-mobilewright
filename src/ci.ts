import { envValue } from './env.js';

const env = (name: string): string | undefined => process.env[name] || undefined;

/**
 * Build name from the CI provider, so sessions group without configuration.
 * Checked in order; the first provider that identifies itself wins.
 */
export function detectBuildName(): string | undefined {
  const explicit = envValue('BUILD');
  if (explicit) return explicit;

  if (env('GITHUB_ACTIONS')) {
    const repo = env('GITHUB_REPOSITORY');
    const run = env('GITHUB_RUN_NUMBER');
    return repo && run ? `${repo} #${run}` : repo;
  }
  if (env('GITLAB_CI')) {
    const project = env('CI_PROJECT_PATH');
    const pipeline = env('CI_PIPELINE_IID');
    return project && pipeline ? `${project} #${pipeline}` : project;
  }
  if (env('CIRCLECI')) {
    const repo = env('CIRCLE_PROJECT_REPONAME');
    const build = env('CIRCLE_BUILD_NUM');
    return repo && build ? `${repo} #${build}` : repo;
  }
  if (env('BUILDKITE')) {
    const pipeline = env('BUILDKITE_PIPELINE_SLUG');
    const number = env('BUILDKITE_BUILD_NUMBER');
    return pipeline && number ? `${pipeline} #${number}` : pipeline;
  }
  if (env('BITRISE_IO')) {
    const app = env('BITRISE_APP_TITLE');
    const number = env('BITRISE_BUILD_NUMBER');
    return app && number ? `${app} #${number}` : app;
  }
  if (env('TF_BUILD')) {
    const project = env('BUILD_REPOSITORY_NAME');
    const number = env('BUILD_BUILDNUMBER');
    return project && number ? `${project} #${number}` : project;
  }
  if (env('JENKINS_URL')) {
    const job = env('JOB_NAME');
    const number = env('BUILD_NUMBER');
    return job && number ? `${job} #${number}` : job;
  }
  if (env('TEAMCITY_VERSION')) {
    return env('TEAMCITY_BUILDCONF_NAME');
  }
  return undefined;
}
