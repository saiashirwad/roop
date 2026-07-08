import { Effect, Stream } from "effect"
import type { PlatformError } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import { toToolFailure } from "./failure.ts"

export const maxProcessOutputChars = 50_000

export type ProcessResult = {
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

const truncate = (text: string, maxChars: number): { text: string; truncated: boolean } => {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, maxChars), truncated: true }
}

const runHostProcess = (
  spawner: ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  maxOutputChars: number = maxProcessOutputChars,
): Effect.Effect<ProcessResult, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { cwd }))

    const [stdoutRaw, stderrRaw, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    )

    const stdout = truncate(stdoutRaw, maxOutputChars)
    const stderr = truncate(stderrRaw, maxOutputChars)

    return {
      args: [...args],
      cwd,
      exitCode: Number(exitCode),
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    } satisfies ProcessResult
  }).pipe(Effect.scoped)

export const runProcess = (
  spawner: ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  maxOutputChars: number = maxProcessOutputChars,
) => runHostProcess(spawner, command, args, cwd, maxOutputChars).pipe(Effect.catch(toToolFailure))
