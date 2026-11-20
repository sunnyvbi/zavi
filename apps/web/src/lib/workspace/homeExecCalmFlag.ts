export function isHomeExecCalmEnabled(): boolean {
  const v = process.env.NEXT_PUBLIC_HOME_EXEC_CALM;
  return v !== "0" && v !== "false";
}
