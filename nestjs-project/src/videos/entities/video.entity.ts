import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  VideoFailureReason,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from '../video.enums';

/**
 * The pg driver returns `bigint` and `numeric` as strings to avoid precision
 * loss; every value stored here stays below Number.MAX_SAFE_INTEGER.
 */
const numberTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Index(['processing_status', 'created_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  mime_type: string;

  @Column({ type: 'bigint', transformer: numberTransformer })
  declared_size_bytes: number;

  @Column({
    type: 'enum',
    enum: VideoProcessingStatus,
    enumName: 'video_processing_status',
    default: VideoProcessingStatus.PENDING_UPLOAD,
  })
  processing_status: VideoProcessingStatus;

  @Column({
    type: 'enum',
    enum: VideoPublicationStatus,
    enumName: 'video_publication_status',
    default: VideoPublicationStatus.DRAFT,
  })
  publication_status: VideoPublicationStatus;

  @Column({ type: 'varchar', length: 50, nullable: true })
  failure_reason: VideoFailureReason | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: numberTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  container_format: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: numberTransformer })
  bitrate: number | null;

  @Column({ type: 'bigint', nullable: true, transformer: numberTransformer })
  size_bytes: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
