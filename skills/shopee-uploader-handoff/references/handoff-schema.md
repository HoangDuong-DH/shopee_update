# Handoff schema

The runtime schema is exported as `managementHandoffSchema` and accepts only:

- schema version and update time;
- repository branch and commit;
- one current objective and overall state;
- authoritative source labels, locations, and kinds;
- active work with status and next action;
- do-not-replay operation identities;
- verification with result and optional evidence reference;
- known limits and next actions.

The schema is strict. Undeclared fields are rejected so credentials or ad-hoc payloads are not accidentally serialized into a model handoff.
