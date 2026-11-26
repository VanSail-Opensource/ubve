/* UBVE packet decoder ABI 1. The worker owns one context, packet and frame. */
#include <stdint.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/intreadwrite.h>
#include <libavutil/mastering_display_metadata.h>
#include <libavutil/mem.h>
#include <libavutil/pixdesc.h>

static AVCodecContext *decoder;
static AVPacket *packet;
static AVFrame *frame;
static int pending, ready, is_video;
static int32_t shape[64];

enum { AGAIN, OK, END };

void ubve_close(void) {
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&decoder);
    pending = ready = is_video = 0;
}

int ubve_open(const char *name, int video, int width, int height,
              int rate, int channels, const uint8_t *extra, int extra_size,
              int tb_num, int tb_den) {
    if (decoder || !name || extra_size < 0 || extra_size > 1048576 ||
        tb_num <= 0 || tb_den <= 0 ||
        (video ? width < 1 || width > 4096 || height < 1 || height > 2160
               : rate < 8000 || rate > 192000 || channels < 1 || channels > 8))
        return AVERROR(EINVAL);
    const AVCodec *codec = avcodec_find_decoder_by_name(name);
    if (!codec || codec->type != (video ? AVMEDIA_TYPE_VIDEO : AVMEDIA_TYPE_AUDIO))
        return AVERROR_DECODER_NOT_FOUND;
    decoder = avcodec_alloc_context3(codec);
    frame = av_frame_alloc();
    packet = av_packet_alloc();
    int result = AVERROR(ENOMEM);
    if (!decoder || !frame || !packet) goto failed;
    if (extra_size) {
        decoder->extradata = av_mallocz(extra_size + AV_INPUT_BUFFER_PADDING_SIZE);
        if (!decoder->extradata) goto failed;
        memcpy(decoder->extradata, extra, extra_size);
        decoder->extradata_size = extra_size;
    }
    decoder->thread_count = 1;
    decoder->err_recognition = AV_EF_CAREFUL | AV_EF_EXPLODE;
    decoder->flags |= AV_CODEC_FLAG_COPY_OPAQUE | AV_CODEC_FLAG_BITEXACT;
    decoder->flags2 |= AV_CODEC_FLAG2_SKIP_MANUAL;
    decoder->pkt_timebase = (AVRational){ tb_num, tb_den };
    decoder->max_pixels = 4096 * 2176; /* includes decoder-aligned heights */
    decoder->max_samples = 65536;
    if (video) {
        decoder->width = width;
        decoder->height = height;
    } else {
        decoder->sample_rate = rate;
        /* Let encoded stream metadata establish mapping for compressed audio. */
        if (codec->name[0] == 'p' && strncmp(codec->name, "pcm_", 4) == 0)
            av_channel_layout_default(&decoder->ch_layout, channels);
        else
            decoder->ch_layout = (AVChannelLayout){ .order = AV_CHANNEL_ORDER_UNSPEC,
                                                  .nb_channels = channels };
    }
    is_video = video;
    result = avcodec_open2(decoder, codec, NULL);
    if (result >= 0) return OK;
failed:
    ubve_close();
    return result;
}

uint8_t *ubve_packet(int size, int token, int64_t pts, int64_t dts, int64_t duration, int key) {
    if (!decoder || pending || ready || size <= 0 || size > 32 * 1024 * 1024 ||
        token <= 0 || av_new_packet(packet, size) < 0) return NULL;
    packet->opaque = (void *)(uintptr_t)token;
    packet->pts = pts;
    packet->dts = dts;
    packet->duration = duration;
    packet->flags = key ? AV_PKT_FLAG_KEY : 0;
    pending = 1;
    return packet->data;
}

int ubve_send(void) {
    if (!decoder || !pending || ready) return AVERROR(EINVAL);
    int result = avcodec_send_packet(decoder, packet);
    if (result == AVERROR(EAGAIN)) return AGAIN;
    av_packet_unref(packet);
    pending = 0;
    return result < 0 ? result : OK;
}

int ubve_flush(void) {
    if (!decoder || pending || ready) return AVERROR(EINVAL);
    int result = avcodec_send_packet(decoder, NULL);
    if (result == AVERROR(EAGAIN)) return AGAIN;
    if (result == AVERROR_EOF) return END;
    return result < 0 ? result : OK;
}

int ubve_receive(void) {
    if (!decoder || ready) return AVERROR(EINVAL);
    int result = avcodec_receive_frame(decoder, frame);
    if (result == AVERROR(EAGAIN)) return AGAIN;
    if (result == AVERROR_EOF) return END;
    if (result < 0) return result;
    ready = 1;
    if (frame->decode_error_flags || (frame->flags & AV_FRAME_FLAG_CORRUPT))
        return AVERROR_INVALIDDATA;
    /* DTS-HD is not an alias for conventional DTS Core. */
    if (decoder->codec_id == AV_CODEC_ID_DTS && decoder->profile != AV_PROFILE_DTS &&
        decoder->profile != AV_PROFILE_UNKNOWN) return AVERROR_PATCHWELCOME;
    return OK;
}

void ubve_release(void) {
    if (ready) av_frame_unref(frame);
    ready = 0;
}

int64_t ubve_pts(void) { return ready ? frame->pts : AV_NOPTS_VALUE; }
int64_t ubve_duration(void) { return ready ? frame->duration : 0; }
const uint8_t *ubve_plane(int i) {
    return ready && i >= 0 && i < 8 && frame->extended_data ? frame->extended_data[i] : NULL;
}

/* The host validates all shape fields and heap extents before copying. */
const int32_t *ubve_shape(void) {
    if (!ready) return NULL;
    memset(shape, 0, sizeof(shape));
    shape[0] = is_video;
    shape[1] = (int32_t)(uintptr_t)frame->opaque;
    if (is_video) {
        shape[2] = frame->format == AV_PIX_FMT_YUV420P10LE ? 10 :
                   frame->format == AV_PIX_FMT_YUV420P || frame->format == AV_PIX_FMT_YUVJ420P ? 8 : 0;
        shape[3] = frame->width;
        shape[4] = frame->height;
        shape[5] = frame->crop_left;
        shape[6] = frame->crop_top;
        shape[7] = frame->crop_right;
        shape[8] = frame->crop_bottom;
        shape[9] = frame->color_primaries;
        shape[10] = frame->color_trc;
        shape[11] = frame->colorspace;
        shape[12] = frame->format == AV_PIX_FMT_YUVJ420P ? AVCOL_RANGE_JPEG : frame->color_range;
        for (int i = 0; i < 3; i++) shape[13 + i] = frame->linesize[i];
        const AVFrameSideData *master = av_frame_get_side_data(frame, AV_FRAME_DATA_MASTERING_DISPLAY_METADATA);
        const AVFrameSideData *light = av_frame_get_side_data(frame, AV_FRAME_DATA_CONTENT_LIGHT_LEVEL);
        if (master && master->size >= sizeof(AVMasteringDisplayMetadata)) {
            const AVMasteringDisplayMetadata *m = (const void *)master->data;
            shape[16] = (m->has_primaries != 0) | ((m->has_luminance != 0) << 1);
            const AVRational values[] = {
                m->display_primaries[0][0], m->display_primaries[0][1],
                m->display_primaries[1][0], m->display_primaries[1][1],
                m->display_primaries[2][0], m->display_primaries[2][1],
                m->white_point[0], m->white_point[1], m->min_luminance, m->max_luminance,
            };
            for (int i = 0; i < 10; i++) {
                shape[17 + i * 2] = values[i].num;
                shape[18 + i * 2] = values[i].den;
            }
        }
        if (light && light->size >= sizeof(AVContentLightMetadata)) {
            const AVContentLightMetadata *c = (const void *)light->data;
            shape[37] = 1;
            shape[38] = c->MaxCLL;
            shape[39] = c->MaxFALL;
        }
        shape[40] = frame->chroma_location;
    } else {
        enum AVSampleFormat packed = av_get_packed_sample_fmt(frame->format);
        shape[2] = packed == AV_SAMPLE_FMT_S16 ? 1 : packed == AV_SAMPLE_FMT_S32 ? 2 :
                   packed == AV_SAMPLE_FMT_FLT ? 3 : packed == AV_SAMPLE_FMT_DBL ? 4 : 0;
        shape[3] = av_sample_fmt_is_planar(frame->format);
        shape[4] = frame->sample_rate;
        shape[5] = frame->nb_samples;
        shape[6] = frame->ch_layout.nb_channels;
        shape[7] = decoder->bits_per_raw_sample;
        shape[8] = frame->linesize[0];
        for (int i = 0; i < frame->ch_layout.nb_channels && i < 8; i++)
            shape[9 + i] = av_channel_layout_channel_from_index(&frame->ch_layout, i);
        const AVFrameSideData *skip = av_frame_get_side_data(frame, AV_FRAME_DATA_SKIP_SAMPLES);
        if (skip && skip->size >= 10) {
            shape[17] = AV_RL32(skip->data);
            shape[18] = AV_RL32(skip->data + 4);
        }
    }
    return shape;
}
