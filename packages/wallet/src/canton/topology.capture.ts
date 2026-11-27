/**
 * Real answers of `POST /v2/parties/external/generate-topology` (CAN-2414), not
 * built by hand: Canton 3.4.11 (the `canton.jar` of Daml SDK 3.4.11), a local
 * in-memory synchronizer with two participants, captured 2026-11-18. The `own`
 * topology was then signed and accepted by `/v2/parties/external/allocate`.
 *
 * - `own`: key A, hosted on the local participant alone (what the backend asks for);
 * - `otherConfirmer`: key A, the other participant confirming too (threshold 2);
 * - `observer`: key A, the other participant observing;
 * - `foreignKey`: key B's own topology.
 *
 * `multiHash` is hex; the throwaway keys' private halves were never kept.
 */
export const CAPTURE = {
  "keyA": "846b9a8af650dd456143234d9aa84bb78684b5a097f64db054e885b755802306",
  "keyB": "04793cd20edafdd9e2c947e0b92144ba7dea7476eea6edd3421ed756335d06f4",
  "localParticipant": "participant1::12200dcc3dd534a04a79df7ddb956fe3a32b1ceae455e1652a3666b15e4dba57c6ec",
  "otherParticipant": "participant2::122015c800309dbd4ba2139a592d89cc4438668ba2b25a27e61dddb081b664342e45",
  "cases": {
    "own": {
      "partyId": "cancore_cap::1220674777396145ff9cb6762ccfdf456b7ca285ea2c4cc10f574626302e192e2951",
      "multiHash": "12201fdae1baa7fd529077eb9d0458f8d1cbbe12fdf26df1e74b0e7fb6581d3b82c9",
      "topologyTransactions": [
        "CvQBCAEQARrtAUrqAQpRY2FuY29yZV9jYXA6OjEyMjA2NzQ3NzczOTYxNDVmZjljYjY3NjJjY2ZkZjQ1NmI3Y2EyODVlYTJjNGNjMTBmNTc0NjI2MzAyZTE5MmUyOTUxEAEaVgpScGFydGljaXBhbnQxOjoxMjIwMGRjYzNkZDUzNGEwNGE3OWRmN2RkYjk1NmZlM2EzMmIxY2VhZTQ1NWUxNjUyYTM2NjZiMTVlNGRiYTU3YzZlYxACMjsKNxAEGiwwKjAFBgMrZXADIQCEa5qK9lDdRWFDI02aqEu3hoS1oJf2TbBU6IW3VYAjBioDAQUEMAEQARAe"
      ]
    },
    "otherConfirmer": {
      "partyId": "cancore_cap::1220674777396145ff9cb6762ccfdf456b7ca285ea2c4cc10f574626302e192e2951",
      "multiHash": "12208926c8ce934d4db83a66b0eea7cc4273cefade21a5ab444100878e14d3d0b9c3",
      "topologyTransactions": [
        "CswCCAEQARrFAkrCAgpRY2FuY29yZV9jYXA6OjEyMjA2NzQ3NzczOTYxNDVmZjljYjY3NjJjY2ZkZjQ1NmI3Y2EyODVlYTJjNGNjMTBmNTc0NjI2MzAyZTE5MmUyOTUxEAIaVgpScGFydGljaXBhbnQxOjoxMjIwMGRjYzNkZDUzNGEwNGE3OWRmN2RkYjk1NmZlM2EzMmIxY2VhZTQ1NWUxNjUyYTM2NjZiMTVlNGRiYTU3YzZlYxACGlYKUnBhcnRpY2lwYW50Mjo6MTIyMDE1YzgwMDMwOWRiZDRiYTIxMzlhNTkyZDg5Y2M0NDM4NjY4YmEyYjI1YTI3ZTYxZGRkYjA4MWI2NjQzNDJlNDUQAjI7CjcQBBosMCowBQYDK2VwAyEAhGuaivZQ3UVhQyNNmqhLt4aEtaCX9k2wVOiFt1WAIwYqAwEFBDABEAEQHg=="
      ]
    },
    "observer": {
      "partyId": "cancore_cap::1220674777396145ff9cb6762ccfdf456b7ca285ea2c4cc10f574626302e192e2951",
      "multiHash": "12200a095f61d3ef6ab0feeea4f64ef23295cf3e5319f03fbc98ae03823efcbd9b35",
      "topologyTransactions": [
        "CswCCAEQARrFAkrCAgpRY2FuY29yZV9jYXA6OjEyMjA2NzQ3NzczOTYxNDVmZjljYjY3NjJjY2ZkZjQ1NmI3Y2EyODVlYTJjNGNjMTBmNTc0NjI2MzAyZTE5MmUyOTUxEAEaVgpScGFydGljaXBhbnQxOjoxMjIwMGRjYzNkZDUzNGEwNGE3OWRmN2RkYjk1NmZlM2EzMmIxY2VhZTQ1NWUxNjUyYTM2NjZiMTVlNGRiYTU3YzZlYxACGlYKUnBhcnRpY2lwYW50Mjo6MTIyMDE1YzgwMDMwOWRiZDRiYTIxMzlhNTkyZDg5Y2M0NDM4NjY4YmEyYjI1YTI3ZTYxZGRkYjA4MWI2NjQzNDJlNDUQAzI7CjcQBBosMCowBQYDK2VwAyEAhGuaivZQ3UVhQyNNmqhLt4aEtaCX9k2wVOiFt1WAIwYqAwEFBDABEAEQHg=="
      ]
    },
    "foreignKey": {
      "partyId": "cancore_cap::12207e0b4345f8450ebb1c7a15d74c138d4cf007c037c518bb34f2c1f3a3c7cd21f3",
      "multiHash": "1220ceb0ef623afcc115ffe23082f95dce41b0bcdf0b9677c375647b8fabe502611b",
      "topologyTransactions": [
        "CvQBCAEQARrtAUrqAQpRY2FuY29yZV9jYXA6OjEyMjA3ZTBiNDM0NWY4NDUwZWJiMWM3YTE1ZDc0YzEzOGQ0Y2YwMDdjMDM3YzUxOGJiMzRmMmMxZjNhM2M3Y2QyMWYzEAEaVgpScGFydGljaXBhbnQxOjoxMjIwMGRjYzNkZDUzNGEwNGE3OWRmN2RkYjk1NmZlM2EzMmIxY2VhZTQ1NWUxNjUyYTM2NjZiMTVlNGRiYTU3YzZlYxACMjsKNxAEGiwwKjAFBgMrZXADIQAEeTzSDtr92eLJR+C5IUS6fep0du6m7dNCHtdWM10G9CoDAQUEMAEQARAe"
      ]
    }
  }
} as const;
