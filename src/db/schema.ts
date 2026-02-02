import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const challenges = sqliteTable(
  "challenges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    chatTitle: text("chat_title").notNull(),
    creatorId: integer("creator_id").notNull(),

    durationMonths: integer("duration_months").notNull(),
    stakeAmount: real("stake_amount").notNull(),
    disciplineThreshold: real("discipline_threshold").notNull(),
    maxSkips: integer("max_skips").notNull(),

    bankHolderId: integer("bank_holder_id"),
    bankHolderUsername: text("bank_holder_username"),

    status: text("status").notNull(), // draft | pending_payments | active | completed | cancelled

    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    endsAt: integer("ends_at")
  },
  (t) => ({
    chatIdx: index("challenges_chat_id_idx").on(t.chatId)
  })
);

export const participants = sqliteTable(
  "participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    challengeId: integer("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),

    track: text("track"), // cut | bulk
    startWeight: real("start_weight"),
    startWaist: real("start_waist"),
    height: real("height"),

    startPhotoFrontId: text("start_photo_front_id"),
    startPhotoLeftId: text("start_photo_left_id"),
    startPhotoRightId: text("start_photo_right_id"),
    startPhotoBackId: text("start_photo_back_id"),

    totalCheckins: integer("total_checkins").notNull().default(0),
    completedCheckins: integer("completed_checkins").notNull().default(0),
    skippedCheckins: integer("skipped_checkins").notNull().default(0),

    pendingCheckinWindowId: integer("pending_checkin_window_id"),
    pendingCheckinRequestedAt: integer("pending_checkin_requested_at"),

    status: text("status").notNull(), // onboarding | pending_payment | payment_marked | active | dropped | disqualified | completed
    joinedAt: integer("joined_at").notNull(),
    onboardingCompletedAt: integer("onboarding_completed_at")
  },
  (t) => ({
    uniqUserInChallenge: uniqueIndex("participants_challenge_user_uniq").on(
      t.challengeId,
      t.userId
    ),
    challengeIdx: index("participants_challenge_id_idx").on(t.challengeId),
    userIdx: index("participants_user_id_idx").on(t.userId),
    statusIdx: index("participants_status_idx").on(t.status)
  })
);

export const goals = sqliteTable(
  "goals",
  {
    participantId: integer("participant_id")
      .primaryKey()
      .references(() => participants.id, { onDelete: "cascade" }),
    targetWeight: real("target_weight").notNull(),
    targetWaist: real("target_waist").notNull(),

    isValidated: integer("is_validated", { mode: "boolean" })
      .notNull()
      .default(false),
    validationResult: text("validation_result"), // realistic | too_aggressive | too_easy
    validationFeedback: text("validation_feedback"),
    validatedAt: integer("validated_at"),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => ({
    validatedIdx: index("goals_is_validated_idx").on(t.isValidated)
  })
);

export const checkinWindows = sqliteTable(
  "checkin_windows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    challengeId: integer("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    windowNumber: integer("window_number").notNull(),
    opensAt: integer("opens_at").notNull(),
    closesAt: integer("closes_at").notNull(),
    reminderSentAt: integer("reminder_sent_at"),
    status: text("status").notNull() // scheduled | open | closed
  },
  (t) => ({
    uniqWindow: uniqueIndex("checkin_windows_challenge_number_uniq").on(
      t.challengeId,
      t.windowNumber
    ),
    statusIdx: index("checkin_windows_status_idx").on(t.status),
    opensIdx: index("checkin_windows_opens_at_idx").on(t.opensAt),
    closesIdx: index("checkin_windows_closes_at_idx").on(t.closesAt)
  })
);

export const checkins = sqliteTable(
  "checkins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    participantId: integer("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    windowId: integer("window_id")
      .notNull()
      .references(() => checkinWindows.id, { onDelete: "cascade" }),
    weight: real("weight").notNull(),
    waist: real("waist").notNull(),
    photoFrontId: text("photo_front_id"),
    photoLeftId: text("photo_left_id"),
    photoRightId: text("photo_right_id"),
    photoBackId: text("photo_back_id"),
    submittedAt: integer("submitted_at").notNull()
  },
  (t) => ({
    uniqParticipantWindow: uniqueIndex("checkins_participant_window_uniq").on(
      t.participantId,
      t.windowId
    ),
    participantIdx: index("checkins_participant_id_idx").on(t.participantId),
    windowIdx: index("checkins_window_id_idx").on(t.windowId)
  })
);

export const commitmentTemplates = sqliteTable(
  "commitment_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(), // nutrition|exercise|lifestyle
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(true)
  },
  (t) => ({
    activeIdx: index("commitment_templates_is_active_idx").on(t.isActive),
    uniqName: uniqueIndex("commitment_templates_name_uniq").on(t.name)
  })
);

export const participantCommitments = sqliteTable(
  "participant_commitments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    participantId: integer("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    templateId: integer("template_id")
      .notNull()
      .references(() => commitmentTemplates.id, { onDelete: "restrict" }),
    createdAt: integer("created_at").notNull()
  },
  (t) => ({
    uniqParticipantTemplate: uniqueIndex("participant_commitments_uniq").on(
      t.participantId,
      t.templateId
    ),
    participantIdx: index("participant_commitments_participant_id_idx").on(
      t.participantId
    )
  })
);

export const payments = sqliteTable(
  "payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    participantId: integer("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // pending | marked_paid | confirmed | refunded
    markedPaidAt: integer("marked_paid_at"),
    confirmedAt: integer("confirmed_at"),
    confirmedBy: integer("confirmed_by")
  },
  (t) => ({
    uniqParticipant: uniqueIndex("payments_participant_uniq").on(t.participantId),
    statusIdx: index("payments_status_idx").on(t.status)
  })
);

export const bankHolderElections = sqliteTable(
  "bank_holder_elections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    challengeId: integer("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    initiatedBy: integer("initiated_by").notNull(),
    status: text("status").notNull(), // in_progress | completed | cancelled
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at")
  },
  (t) => ({
    uniqChallenge: uniqueIndex("bank_holder_elections_challenge_uniq").on(
      t.challengeId
    ),
    statusIdx: index("bank_holder_elections_status_idx").on(t.status)
  })
);

export const bankHolderVotes = sqliteTable(
  "bank_holder_votes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    electionId: integer("election_id")
      .notNull()
      .references(() => bankHolderElections.id, { onDelete: "cascade" }),
    voterId: integer("voter_id").notNull(),
    votedForId: integer("voted_for_id").notNull(),
    votedAt: integer("voted_at").notNull()
  },
  (t) => ({
    uniqVoter: uniqueIndex("bank_holder_votes_election_voter_uniq").on(
      t.electionId,
      t.voterId
    ),
    electionIdx: index("bank_holder_votes_election_id_idx").on(t.electionId)
  })
);

export const checkinRecommendations = sqliteTable(
  "checkin_recommendations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    checkinId: integer("checkin_id")
      .notNull()
      .references(() => checkins.id, { onDelete: "cascade" }),
    participantId: integer("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    progressAssessment: text("progress_assessment"),
    bodyCompositionNotes: text("body_composition_notes"),
    nutritionAdvice: text("nutrition_advice"),
    trainingAdvice: text("training_advice"),
    motivationalMessage: text("motivational_message"),
    warningFlags: text("warning_flags"), // JSON string
    llmModel: text("llm_model"),
    tokensUsed: integer("tokens_used"),
    processingTimeMs: integer("processing_time_ms"),
    createdAt: integer("created_at").notNull()
  },
  (t) => ({
    checkinIdx: uniqueIndex("checkin_recommendations_checkin_uniq").on(t.checkinId),
    participantIdx: index("checkin_recommendations_participant_id_idx").on(
      t.participantId
    )
  })
);

