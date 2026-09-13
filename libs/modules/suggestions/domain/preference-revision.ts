/** Snapshot fingerprint, internal only. No names, selections or location. */
export function preferenceRevision(
  members: {
    memberId: string;
    selectionStatus: string;
    version: number | null;
    isDraft: boolean | null;
  }[],
): string {
  return JSON.stringify(
    members
      .map((member) => [member.memberId, member.selectionStatus, member.version, member.isDraft])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
