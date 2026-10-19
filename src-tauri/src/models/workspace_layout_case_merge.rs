//! Reference implementation of the case-variant merge (PD-10), compiled for tests only.
//!
//! The production merge runs in the front end after hydrate, once the probed semantics have
//! arrived. This copy exists so both sides can be held to one rule set: they read the same
//! scenarios from `contracts/path-key/case-merge-cases.json` and must agree on every one.

use std::collections::{HashMap, HashSet};

use crate::models::workspace_layout::{
    WorkspaceLayoutDocument, WorkspaceLayoutNode, WorkspacePaneContentRef,
};
use crate::platform::case_sensitivity::{CaseSensitivity, PathSemantics};
use crate::platform::path_key::PathKey;
use crate::services::file_service::FileIdentityComparison;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergedGroup {
    pub canonical: String,
    pub variants: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct MergeOutcome {
    pub layout: WorkspaceLayoutDocument,
    pub merged: Vec<MergedGroup>,
}

fn collect_panes<'a>(
    node: &'a mut WorkspaceLayoutNode,
    out: &mut Vec<&'a mut WorkspaceLayoutNode>,
) {
    match node {
        WorkspaceLayoutNode::Pane { .. } => out.push(node),
        WorkspaceLayoutNode::Split { first, second, .. } => {
            collect_panes(first, out);
            collect_panes(second, out);
        }
    }
}

fn file_id(content: &WorkspacePaneContentRef) -> Option<&str> {
    match content {
        WorkspacePaneContentRef::File { document_id } => Some(document_id),
        _ => None,
    }
}

/// Document ids in the order the layout shows them: panes (first before second) with their
/// contents in order, then the detached contents, then whatever the document list adds.
fn first_seen_order(layout: &mut WorkspaceLayoutDocument) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut note = |id: &str| {
        if seen.insert(id.to_owned()) {
            order.push(id.to_owned());
        }
    };
    let mut panes = Vec::new();
    collect_panes(&mut layout.tree, &mut panes);
    for pane in panes {
        if let WorkspaceLayoutNode::Pane { contents, .. } = pane {
            contents.iter().filter_map(file_id).for_each(&mut note);
        }
    }
    layout
        .detached_contents
        .iter()
        .filter_map(file_id)
        .for_each(&mut note);
    layout
        .documents
        .iter()
        .map(|document| document.id.as_str())
        .for_each(&mut note);
    order
}

pub(crate) fn merge_case_variant_documents(
    layout: &WorkspaceLayoutDocument,
    semantics_by_directory: &HashMap<i64, PathSemantics>,
    identity: &dyn Fn(i64, &str, &str) -> FileIdentityComparison,
) -> MergeOutcome {
    let mut layout = layout.clone();
    let order = first_seen_order(&mut layout);
    let by_id: HashMap<&str, usize> = layout
        .documents
        .iter()
        .enumerate()
        .map(|(index, document)| (document.id.as_str(), index))
        .collect();

    // Candidate groups: same directory, same key, directory known to be case insensitive.
    let mut groups: Vec<(i64, PathKey, Vec<String>)> = Vec::new();
    for id in &order {
        let document = &layout.documents[by_id[id.as_str()]];
        let Some(semantics) = semantics_by_directory.get(&document.directory_id) else {
            continue;
        };
        if semantics.case != CaseSensitivity::Insensitive {
            continue;
        }
        let key = PathKey::of(&document.relative_path, semantics);
        match groups.iter_mut().find(|(directory, group_key, _)| {
            *directory == document.directory_id && *group_key == key
        }) {
            Some((_, _, ids)) => ids.push(id.clone()),
            None => groups.push((document.directory_id, key, vec![id.clone()])),
        }
    }

    // Confirm every variant against the canonical file; a different file stays a document.
    let mut merged: Vec<MergedGroup> = Vec::new();
    let mut remap: HashMap<String, String> = HashMap::new();
    for (directory_id, _, ids) in groups.into_iter().filter(|(_, _, ids)| ids.len() > 1) {
        let canonical = ids[0].clone();
        let canonical_path = layout.documents[by_id[canonical.as_str()]]
            .relative_path
            .clone();
        let mut variants = Vec::new();
        for variant in &ids[1..] {
            let variant_path = &layout.documents[by_id[variant.as_str()]].relative_path;
            if identity(directory_id, &canonical_path, variant_path)
                != FileIdentityComparison::Different
            {
                variants.push(variant.clone());
            }
        }
        for variant in &variants {
            remap.insert(variant.clone(), canonical.clone());
        }
        if !variants.is_empty() {
            merged.push(MergedGroup {
                canonical,
                variants,
            });
        }
    }
    if remap.is_empty() {
        return MergeOutcome { layout, merged };
    }

    let rewrite = |content: &WorkspacePaneContentRef| match content {
        WorkspacePaneContentRef::File { document_id } => WorkspacePaneContentRef::File {
            document_id: remap
                .get(document_id)
                .cloned()
                .unwrap_or_else(|| document_id.clone()),
        },
        other => other.clone(),
    };

    // Panes: rewrite references (a pane keeps one tab per file), then keep a file only in the
    // first pane that shows it. A removed active tab hands over to the content now at
    // `min(index, length - 1)`, the rule of the front end's `removeWorkspaceContentFromPane`.
    let mut shown: HashSet<String> = HashSet::new();
    let mut panes = Vec::new();
    collect_panes(&mut layout.tree, &mut panes);
    for pane in panes {
        let WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } = pane
        else {
            continue;
        };
        let mut remapped: Vec<WorkspacePaneContentRef> = Vec::new();
        for content in contents.iter().map(&rewrite) {
            if !remapped.contains(&content) {
                remapped.push(content);
            }
        }
        let mut active = active_content.as_ref().map(&rewrite);
        for content in remapped.clone() {
            let Some(id) = file_id(&content) else {
                continue;
            };
            if shown.insert(id.to_owned()) {
                continue;
            }
            let index = remapped
                .iter()
                .position(|candidate| *candidate == content)
                .expect("the content is still in the pane");
            remapped.remove(index);
            if active.as_ref() == Some(&content) {
                active = remapped
                    .get(index.min(remapped.len().saturating_sub(1)))
                    .cloned();
            }
        }
        *contents = remapped;
        *active_content = active;
    }

    // Detached contents follow the same rule, and never repeat a file the tree shows.
    let mut detached = Vec::new();
    for content in layout.detached_contents.iter().map(&rewrite) {
        match file_id(&content) {
            Some(id) if !shown.insert(id.to_owned()) => {}
            _ => detached.push(content),
        }
    }
    layout.detached_contents = detached;

    layout
        .documents
        .retain(|document| !remap.contains_key(&document.id));
    MergeOutcome { layout, merged }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::Value;

    use super::{merge_case_variant_documents, MergedGroup};
    use crate::models::workspace_layout::{
        WorkspaceFileDocument, WorkspaceLayoutDocument, WorkspaceLayoutNode,
        WorkspacePaneContentRef, WorkspaceSplitDirection, WORKSPACE_LAYOUT_SCHEMA_VERSION,
    };
    use crate::platform::case_sensitivity::PathSemantics;
    use crate::services::file_service::FileIdentityComparison;

    const CASES: &str = include_str!("../../../contracts/path-key/case-merge-cases.json");

    fn ids(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_owned())
            .collect()
    }

    /// Layouts only accept UUID document ids: scenario names map to fixed UUIDs and back.
    fn uuid_for(name: &str) -> String {
        let number = name
            .bytes()
            .fold(0u128, |number, byte| number * 256 + u128::from(byte));
        uuid::Uuid::from_u128(number).to_string()
    }

    fn name_of(case: &Value, uuid: &str) -> String {
        case["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|document| document["id"].as_str().unwrap())
            .find(|name| uuid_for(name) == uuid)
            .unwrap_or_else(|| panic!("unknown document {uuid}"))
            .to_owned()
    }

    fn file(id: &str) -> WorkspacePaneContentRef {
        WorkspacePaneContentRef::File {
            document_id: uuid_for(id),
        }
    }

    /// A flat scenario (panes in order, one detached list) as a real layout document.
    fn layout_of(case: &Value) -> WorkspaceLayoutDocument {
        let mut tree: Option<WorkspaceLayoutNode> = None;
        for (index, pane) in case["panes"].as_array().unwrap().iter().enumerate() {
            let contents: Vec<WorkspacePaneContentRef> =
                ids(&pane["contents"]).iter().map(|id| file(id)).collect();
            let node = WorkspaceLayoutNode::Pane {
                id: pane["id"].as_str().unwrap().to_owned(),
                pane_number: index as u32 + 1,
                active_content: pane["active"].as_str().map(file),
                contents,
            };
            tree = Some(match tree {
                None => node,
                Some(first) => WorkspaceLayoutNode::Split {
                    id: format!("split-{index}"),
                    direction: WorkspaceSplitDirection::Horizontal,
                    ratio: 0.5,
                    first: Box::new(first),
                    second: Box::new(node),
                },
            });
        }
        WorkspaceLayoutDocument {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            tree: tree.unwrap(),
            focused_pane_id: case["panes"][0]["id"].as_str().unwrap().to_owned(),
            slots: Vec::new(),
            documents: case["documents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|document| WorkspaceFileDocument {
                    id: uuid_for(document["id"].as_str().unwrap()),
                    directory_id: document["directoryId"].as_i64().unwrap(),
                    directory_path: format!("/work/dir{}", document["directoryId"]),
                    relative_path: document["relativePath"].as_str().unwrap().to_owned(),
                })
                .collect(),
            detached_contents: ids(&case["detached"]).iter().map(|id| file(id)).collect(),
        }
    }

    fn pane_contents(
        case: &Value,
        node: &WorkspaceLayoutNode,
        out: &mut Vec<(String, Vec<String>, Option<String>)>,
    ) {
        match node {
            WorkspaceLayoutNode::Pane {
                id,
                contents,
                active_content,
                ..
            } => out.push((
                id.clone(),
                contents
                    .iter()
                    .map(|content| match content {
                        WorkspacePaneContentRef::File { document_id } => name_of(case, document_id),
                        other => panic!("unexpected content {other:?}"),
                    })
                    .collect(),
                active_content.as_ref().map(|content| match content {
                    WorkspacePaneContentRef::File { document_id } => name_of(case, document_id),
                    other => panic!("unexpected active content {other:?}"),
                }),
            )),
            WorkspaceLayoutNode::Split { first, second, .. } => {
                pane_contents(case, first, out);
                pane_contents(case, second, out);
            }
        }
    }

    #[test]
    fn merge_case_variant_documents_applies_the_documented_rules() {
        let document: Value = serde_json::from_str(CASES).unwrap();
        assert_eq!(document["version"], 1);
        let cases = document["cases"].as_array().unwrap();
        assert!(cases.len() >= 9, "the nine required scenarios must exist");
        let names: Vec<&str> = cases
            .iter()
            .map(|case| case["name"].as_str().unwrap())
            .collect();
        for required in [
            "insensitive-same-identity-merges-into-first-seen",
            "insensitive-different-identity-does-not-merge",
            "insensitive-unavailable-identity-merges-by-flag",
            "unknown-never-merges",
            "sensitive-never-merges",
            "canonical-is-the-first-seen-in-tree-order",
            "rewrites-references-and-keeps-the-first-pane",
            "detached-contents-are-merged-the-same-way",
            "documents-in-different-directories-are-never-merged",
        ] {
            assert!(names.contains(&required), "missing scenario {required}");
        }

        for case in cases {
            let name = case["name"].as_str().unwrap();
            let layout = layout_of(case);
            layout
                .validate()
                .unwrap_or_else(|error| panic!("{name}: input invalid: {error:?}"));

            let semantics: HashMap<i64, PathSemantics> = case["semantics"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(directory, value)| {
                    (
                        directory.parse().unwrap(),
                        serde_json::from_value(value.clone()).unwrap(),
                    )
                })
                .collect();
            let identities = case["fileIdentity"].as_object().unwrap();
            let identity = |_directory: i64, canonical: &str, variant: &str| match identities
                .get(&format!("{canonical}|{variant}"))
                .and_then(Value::as_str)
                .unwrap_or("unavailable")
            {
                "same" => FileIdentityComparison::Same,
                "different" => FileIdentityComparison::Different,
                _ => FileIdentityComparison::Unavailable,
            };

            let outcome = merge_case_variant_documents(&layout, &semantics, &identity);
            outcome
                .layout
                .validate()
                .unwrap_or_else(|error| panic!("{name}: merged layout invalid: {error:?}"));

            let expected = &case["expected"];
            let documents: Vec<String> = outcome
                .layout
                .documents
                .iter()
                .map(|document| name_of(case, &document.id))
                .collect();
            assert_eq!(documents, ids(&expected["documents"]), "{name}: documents");

            let mut panes = Vec::new();
            pane_contents(case, &outcome.layout.tree, &mut panes);
            let expected_panes: Vec<(String, Vec<String>, Option<String>)> = expected["panes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pane| {
                    (
                        pane["id"].as_str().unwrap().to_owned(),
                        ids(&pane["contents"]),
                        pane["active"].as_str().map(str::to_owned),
                    )
                })
                .collect();
            assert_eq!(
                panes, expected_panes,
                "{name}: panes (id, contents, active tab)"
            );

            let detached: Vec<String> = outcome
                .layout
                .detached_contents
                .iter()
                .map(|content| match content {
                    WorkspacePaneContentRef::File { document_id } => name_of(case, document_id),
                    other => panic!("unexpected detached content {other:?}"),
                })
                .collect();
            assert_eq!(detached, ids(&expected["detached"]), "{name}: detached");

            let expected_merged: Vec<MergedGroup> = expected["merged"]
                .as_array()
                .unwrap()
                .iter()
                .map(|group| MergedGroup {
                    canonical: group["canonical"].as_str().unwrap().to_owned(),
                    variants: ids(&group["variants"]),
                })
                .collect();
            let merged_by_name: Vec<MergedGroup> = outcome
                .merged
                .iter()
                .map(|group| MergedGroup {
                    canonical: name_of(case, &group.canonical),
                    variants: group.variants.iter().map(|id| name_of(case, id)).collect(),
                })
                .collect();
            assert_eq!(merged_by_name, expected_merged, "{name}: merged");

            // Reverse assertion: no merged variant survives anywhere in the output.
            for group in &outcome.merged {
                for variant in &group.variants {
                    assert!(
                        !documents.contains(&name_of(case, variant))
                            && panes
                                .iter()
                                .all(|(_, contents, _)| !contents.contains(&name_of(case, variant)))
                            && !detached.contains(&name_of(case, variant)),
                        "{name}: variant {variant} must be gone"
                    );
                }
            }
        }
    }
}
