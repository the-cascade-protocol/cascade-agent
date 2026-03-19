# Cascade Protocol Pod

This directory is a **Cascade Protocol Pod** -- a portable, self-describing collection of personal health data serialized as RDF/Turtle files.

## Structure

```
.well-known/
  solid              # Pod discovery document (JSON)
profile/
  card.ttl           # WebID profile (identity + discovery links)
settings/
  publicTypeIndex.ttl    # Maps clinical data types to file locations
  privateTypeIndex.ttl   # Maps wellness data types to file locations
clinical/            # Clinical records (EHR-sourced data)
wellness/            # Wellness records (device and self-reported data)
index.ttl            # Root LDP container listing all resources
```

## Getting Started

1. Edit `profile/card.ttl` to set the Pod owner's name and demographics.
2. Add clinical data files (e.g., `clinical/medications.ttl`) and register them in `settings/publicTypeIndex.ttl`.
3. Add wellness data files (e.g., `wellness/heart-rate.ttl`) and register them in `settings/privateTypeIndex.ttl`.
4. Update `index.ttl` to list all resources.

## Useful Commands

```bash
cascade pod info .           # Show Pod summary
cascade pod query . --all    # Query all data in the Pod
cascade pod export . --format zip   # Export as ZIP archive
cascade validate .           # Validate against SHACL shapes
```

## Learn More

- Cascade Protocol: https://cascadeprotocol.org
- Pod Structure Spec: https://cascadeprotocol.org/docs/spec/pod-structure
- Cascade SDK: https://github.com/nickthorpe71/cascade-sdk-swift
