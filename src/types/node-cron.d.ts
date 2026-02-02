declare module "node-cron" {
  export type ScheduleOptions = {
    timezone?: string;
  };

  export type ScheduledTask = {
    start: () => void;
    stop: () => void;
  };

  export function schedule(
    expression: string,
    func: () => void,
    options?: ScheduleOptions
  ): ScheduledTask;

  const cron: {
    schedule: typeof schedule;
  };

  export default cron;
}

