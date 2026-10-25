/**
 * A reading with its sign always printed, so a column of them does not jump a
 * character as the value crosses zero.
 *
 * Rounded before the sign is chosen. Three scenes each had their own copy that
 * picked the sign from the raw value, so -0.01 printed as "-0.0": a phone held
 * dead level showed a minus sign that flickered with the sensor noise.
 */
export function signed(value: number, digits = 1): string {
  // Number('-0.0') is -0, and -0 >= 0, so a rounded zero always gets '+'.
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded).toFixed(digits)}`;
}
