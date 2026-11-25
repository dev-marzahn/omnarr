/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as api_downloadClients from "../api/downloadClients.js";
import type * as api_indexers from "../api/indexers.js";
import type * as api_issues from "../api/issues.js";
import type * as api_jellyfin from "../api/jellyfin.js";
import type * as api_library from "../api/library.js";
import type * as api_metadata from "../api/metadata.js";
import type * as api_playback from "../api/playback.js";
import type * as api_releaseProfiles from "../api/releaseProfiles.js";
import type * as api_scan from "../api/scan.js";
import type * as api_settings from "../api/settings.js";
import type * as api_setup from "../api/setup.js";
import type * as api_system from "../api/system.js";
import type * as api_units from "../api/units.js";
import type * as auth from "../auth.js";
import type * as authOptions from "../authOptions.js";
import type * as crons from "../crons.js";
import type * as downloadClients_store from "../downloadClients/store.js";
import type * as http from "../http.js";
import type * as indexers_adapter from "../indexers/adapter.js";
import type * as indexers_caps from "../indexers/caps.js";
import type * as indexers_connection from "../indexers/connection.js";
import type * as indexers_dto from "../indexers/dto.js";
import type * as indexers_feed from "../indexers/feed.js";
import type * as indexers_http from "../indexers/http.js";
import type * as indexers_newznab from "../indexers/newznab.js";
import type * as indexers_nyaa from "../indexers/nyaa.js";
import type * as indexers_pacing from "../indexers/pacing.js";
import type * as indexers_rateLimit from "../indexers/rateLimit.js";
import type * as indexers_relay from "../indexers/relay.js";
import type * as indexers_requestPlan from "../indexers/requestPlan.js";
import type * as indexers_sizeText from "../indexers/sizeText.js";
import type * as indexers_store from "../indexers/store.js";
import type * as indexers_torznab from "../indexers/torznab.js";
import type * as indexers_usage from "../indexers/usage.js";
import type * as issues_fixes from "../issues/fixes.js";
import type * as issues_rows from "../issues/rows.js";
import type * as jellyfin_links from "../jellyfin/links.js";
import type * as jellyfin_playback from "../jellyfin/playback.js";
import type * as jellyfin_setup from "../jellyfin/setup.js";
import type * as jobs_artifacts from "../jobs/artifacts.js";
import type * as jobs_clients from "../jobs/clients.js";
import type * as jobs_downloads from "../jobs/downloads.js";
import type * as jobs_imports from "../jobs/imports.js";
import type * as jobs_passwordPushes from "../jobs/passwordPushes.js";
import type * as jobs_queue from "../jobs/queue.js";
import type * as jobs_results from "../jobs/results.js";
import type * as jobs_worker from "../jobs/worker.js";
import type * as lib_derivedState from "../lib/derivedState.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_fetchCappedText from "../lib/fetchCappedText.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_issues from "../lib/issues.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_sha256 from "../lib/sha256.js";
import type * as lib_stateMachine from "../lib/stateMachine.js";
import type * as lib_userAgent from "../lib/userAgent.js";
import type * as library_deleteWork from "../library/deleteWork.js";
import type * as library_misread from "../library/misread.js";
import type * as library_missingFiles from "../library/missingFiles.js";
import type * as library_naming from "../library/naming.js";
import type * as library_read from "../library/read.js";
import type * as library_size from "../library/size.js";
import type * as library_works from "../library/works.js";
import type * as mapping_animeLists from "../mapping/animeLists.js";
import type * as mapping_animeListsParse from "../mapping/animeListsParse.js";
import type * as mapping_listStore from "../mapping/listStore.js";
import type * as mapping_project from "../mapping/project.js";
import type * as mapping_releaseName from "../mapping/releaseName.js";
import type * as mapping_sceneMappingSeasons from "../mapping/sceneMappingSeasons.js";
import type * as mapping_sceneMappings from "../mapping/sceneMappings.js";
import type * as mapping_sceneMappingsParse from "../mapping/sceneMappingsParse.js";
import type * as mapping_sources from "../mapping/sources.js";
import type * as mapping_xem from "../mapping/xem.js";
import type * as mapping_xemNamesParse from "../mapping/xemNamesParse.js";
import type * as metadata_images from "../metadata/images.js";
import type * as metadata_keys from "../metadata/keys.js";
import type * as metadata_numbering from "../metadata/numbering.js";
import type * as metadata_pool from "../metadata/pool.js";
import type * as metadata_provider from "../metadata/provider.js";
import type * as metadata_reconcile from "../metadata/reconcile.js";
import type * as metadata_resolve from "../metadata/resolve.js";
import type * as metadata_schedule from "../metadata/schedule.js";
import type * as metadata_sync from "../metadata/sync.js";
import type * as metadata_tmdb from "../metadata/tmdb.js";
import type * as metadata_write from "../metadata/write.js";
import type * as migrations_0001_blocklist_release_title_key from "../migrations/0001_blocklist_release_title_key.js";
import type * as migrations_0002_work_alias_compact from "../migrations/0002_work_alias_compact.js";
import type * as migrations_0003_work_alias_scene_season from "../migrations/0003_work_alias_scene_season.js";
import type * as migrations_0004_grab_kind from "../migrations/0004_grab_kind.js";
import type * as migrations_0005_definition_yaml_table from "../migrations/0005_definition_yaml_table.js";
import type * as migrations_0006_scene_mapping_seasons_and_filters from "../migrations/0006_scene_mapping_seasons_and_filters.js";
import type * as migrations_0007_work_alias_part_season from "../migrations/0007_work_alias_part_season.js";
import type * as migrations__generated from "../migrations/_generated.js";
import type * as pipeline_backfill from "../pipeline/backfill.js";
import type * as pipeline_blocklist from "../pipeline/blocklist.js";
import type * as pipeline_cleanup from "../pipeline/cleanup.js";
import type * as pipeline_grabs from "../pipeline/grabs.js";
import type * as pipeline_groups from "../pipeline/groups.js";
import type * as pipeline_manualGrab from "../pipeline/manualGrab.js";
import type * as pipeline_pick from "../pipeline/pick.js";
import type * as pipeline_preparation from "../pipeline/preparation.js";
import type * as pipeline_retention from "../pipeline/retention.js";
import type * as pipeline_rss from "../pipeline/rss.js";
import type * as pipeline_rssAction from "../pipeline/rssAction.js";
import type * as pipeline_search from "../pipeline/search.js";
import type * as pipeline_searchAction from "../pipeline/searchAction.js";
import type * as pipeline_steps from "../pipeline/steps.js";
import type * as pipeline_upgrades from "../pipeline/upgrades.js";
import type * as pipeline_workflow from "../pipeline/workflow.js";
import type * as playback_profiles from "../playback/profiles.js";
import type * as playback_target from "../playback/target.js";
import type * as referenceSeeds_0001_release_profiles from "../referenceSeeds/0001_release_profiles.js";
import type * as referenceSeeds_0002_release_profiles_v2 from "../referenceSeeds/0002_release_profiles_v2.js";
import type * as referenceSeeds_0003_playback_profile_defaults from "../referenceSeeds/0003_playback_profile_defaults.js";
import type * as referenceSeeds_shippedProfiles from "../referenceSeeds/shippedProfiles.js";
import type * as scan_importFolder from "../scan/importFolder.js";
import type * as scan_match from "../scan/match.js";
import type * as scan_report from "../scan/report.js";
import type * as scan_review from "../scan/review.js";
import type * as scan_start from "../scan/start.js";
import type * as seeds__generated from "../seeds/_generated.js";
import type * as seeds__reference from "../seeds/_reference.js";
import type * as setup_admin from "../setup/admin.js";
import type * as setup_origins from "../setup/origins.js";
import type * as setup_settings from "../setup/settings.js";
import type * as sites_config from "../sites/config.js";
import type * as sites_definitions from "../sites/definitions.js";
import type * as sites_lease from "../sites/lease.js";
import type * as sites_siteInput from "../sites/siteInput.js";
import type * as updates from "../updates.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "api/downloadClients": typeof api_downloadClients;
  "api/indexers": typeof api_indexers;
  "api/issues": typeof api_issues;
  "api/jellyfin": typeof api_jellyfin;
  "api/library": typeof api_library;
  "api/metadata": typeof api_metadata;
  "api/playback": typeof api_playback;
  "api/releaseProfiles": typeof api_releaseProfiles;
  "api/scan": typeof api_scan;
  "api/settings": typeof api_settings;
  "api/setup": typeof api_setup;
  "api/system": typeof api_system;
  "api/units": typeof api_units;
  auth: typeof auth;
  authOptions: typeof authOptions;
  crons: typeof crons;
  "downloadClients/store": typeof downloadClients_store;
  http: typeof http;
  "indexers/adapter": typeof indexers_adapter;
  "indexers/caps": typeof indexers_caps;
  "indexers/connection": typeof indexers_connection;
  "indexers/dto": typeof indexers_dto;
  "indexers/feed": typeof indexers_feed;
  "indexers/http": typeof indexers_http;
  "indexers/newznab": typeof indexers_newznab;
  "indexers/nyaa": typeof indexers_nyaa;
  "indexers/pacing": typeof indexers_pacing;
  "indexers/rateLimit": typeof indexers_rateLimit;
  "indexers/relay": typeof indexers_relay;
  "indexers/requestPlan": typeof indexers_requestPlan;
  "indexers/sizeText": typeof indexers_sizeText;
  "indexers/store": typeof indexers_store;
  "indexers/torznab": typeof indexers_torznab;
  "indexers/usage": typeof indexers_usage;
  "issues/fixes": typeof issues_fixes;
  "issues/rows": typeof issues_rows;
  "jellyfin/links": typeof jellyfin_links;
  "jellyfin/playback": typeof jellyfin_playback;
  "jellyfin/setup": typeof jellyfin_setup;
  "jobs/artifacts": typeof jobs_artifacts;
  "jobs/clients": typeof jobs_clients;
  "jobs/downloads": typeof jobs_downloads;
  "jobs/imports": typeof jobs_imports;
  "jobs/passwordPushes": typeof jobs_passwordPushes;
  "jobs/queue": typeof jobs_queue;
  "jobs/results": typeof jobs_results;
  "jobs/worker": typeof jobs_worker;
  "lib/derivedState": typeof lib_derivedState;
  "lib/events": typeof lib_events;
  "lib/fetchCappedText": typeof lib_fetchCappedText;
  "lib/functions": typeof lib_functions;
  "lib/issues": typeof lib_issues;
  "lib/limits": typeof lib_limits;
  "lib/sha256": typeof lib_sha256;
  "lib/stateMachine": typeof lib_stateMachine;
  "lib/userAgent": typeof lib_userAgent;
  "library/deleteWork": typeof library_deleteWork;
  "library/misread": typeof library_misread;
  "library/missingFiles": typeof library_missingFiles;
  "library/naming": typeof library_naming;
  "library/read": typeof library_read;
  "library/size": typeof library_size;
  "library/works": typeof library_works;
  "mapping/animeLists": typeof mapping_animeLists;
  "mapping/animeListsParse": typeof mapping_animeListsParse;
  "mapping/listStore": typeof mapping_listStore;
  "mapping/project": typeof mapping_project;
  "mapping/releaseName": typeof mapping_releaseName;
  "mapping/sceneMappingSeasons": typeof mapping_sceneMappingSeasons;
  "mapping/sceneMappings": typeof mapping_sceneMappings;
  "mapping/sceneMappingsParse": typeof mapping_sceneMappingsParse;
  "mapping/sources": typeof mapping_sources;
  "mapping/xem": typeof mapping_xem;
  "mapping/xemNamesParse": typeof mapping_xemNamesParse;
  "metadata/images": typeof metadata_images;
  "metadata/keys": typeof metadata_keys;
  "metadata/numbering": typeof metadata_numbering;
  "metadata/pool": typeof metadata_pool;
  "metadata/provider": typeof metadata_provider;
  "metadata/reconcile": typeof metadata_reconcile;
  "metadata/resolve": typeof metadata_resolve;
  "metadata/schedule": typeof metadata_schedule;
  "metadata/sync": typeof metadata_sync;
  "metadata/tmdb": typeof metadata_tmdb;
  "metadata/write": typeof metadata_write;
  "migrations/0001_blocklist_release_title_key": typeof migrations_0001_blocklist_release_title_key;
  "migrations/0002_work_alias_compact": typeof migrations_0002_work_alias_compact;
  "migrations/0003_work_alias_scene_season": typeof migrations_0003_work_alias_scene_season;
  "migrations/0004_grab_kind": typeof migrations_0004_grab_kind;
  "migrations/0005_definition_yaml_table": typeof migrations_0005_definition_yaml_table;
  "migrations/0006_scene_mapping_seasons_and_filters": typeof migrations_0006_scene_mapping_seasons_and_filters;
  "migrations/0007_work_alias_part_season": typeof migrations_0007_work_alias_part_season;
  "migrations/_generated": typeof migrations__generated;
  "pipeline/backfill": typeof pipeline_backfill;
  "pipeline/blocklist": typeof pipeline_blocklist;
  "pipeline/cleanup": typeof pipeline_cleanup;
  "pipeline/grabs": typeof pipeline_grabs;
  "pipeline/groups": typeof pipeline_groups;
  "pipeline/manualGrab": typeof pipeline_manualGrab;
  "pipeline/pick": typeof pipeline_pick;
  "pipeline/preparation": typeof pipeline_preparation;
  "pipeline/retention": typeof pipeline_retention;
  "pipeline/rss": typeof pipeline_rss;
  "pipeline/rssAction": typeof pipeline_rssAction;
  "pipeline/search": typeof pipeline_search;
  "pipeline/searchAction": typeof pipeline_searchAction;
  "pipeline/steps": typeof pipeline_steps;
  "pipeline/upgrades": typeof pipeline_upgrades;
  "pipeline/workflow": typeof pipeline_workflow;
  "playback/profiles": typeof playback_profiles;
  "playback/target": typeof playback_target;
  "referenceSeeds/0001_release_profiles": typeof referenceSeeds_0001_release_profiles;
  "referenceSeeds/0002_release_profiles_v2": typeof referenceSeeds_0002_release_profiles_v2;
  "referenceSeeds/0003_playback_profile_defaults": typeof referenceSeeds_0003_playback_profile_defaults;
  "referenceSeeds/shippedProfiles": typeof referenceSeeds_shippedProfiles;
  "scan/importFolder": typeof scan_importFolder;
  "scan/match": typeof scan_match;
  "scan/report": typeof scan_report;
  "scan/review": typeof scan_review;
  "scan/start": typeof scan_start;
  "seeds/_generated": typeof seeds__generated;
  "seeds/_reference": typeof seeds__reference;
  "setup/admin": typeof setup_admin;
  "setup/origins": typeof setup_origins;
  "setup/settings": typeof setup_settings;
  "sites/config": typeof sites_config;
  "sites/definitions": typeof sites_definitions;
  "sites/lease": typeof sites_lease;
  "sites/siteInput": typeof sites_siteInput;
  updates: typeof updates;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  workflowMigrations: import("@dev-marzahn/convex-workflow-migrations/_generated/component.js").ComponentApi<"workflowMigrations">;
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  metadataPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"metadataPool">;
};
