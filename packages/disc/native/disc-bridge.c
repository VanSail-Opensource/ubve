/* Read-only libudfread 1.2.0 / libbluray 1.5.0 shim. No navigation/menu API. */
#include <emscripten.h>
#include <udfread/udfread.h>
#include <udfread/blockinput.h>
#include <libbluray/bluray.h>
#include <libbluray/filesystem.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>

#define MAX_HANDLES 64
#define MAX_JSON (1024 * 1024)
#define MAX_READ (1024 * 1024)
static udfread *volume;
static BLURAY *disc;
static int image_mode;
static UDFFILE *udf_files[MAX_HANDLES];
static char json[MAX_JSON];
static size_t json_pos;
static int json_error;

EM_JS(int, js_open, (const char *path), { return Module.ubveIO.open(UTF8ToString(path)); });
EM_JS(double, js_size, (int handle), { return Module.ubveIO.size(handle); });
EM_JS(int, js_read, (int handle, double offset, int ptr, int length), { return Module.ubveIO.read(handle, offset, HEAPU8, ptr, length); });
EM_JS(void, js_close, (int handle), { Module.ubveIO.close(handle); });
EM_JS(int, js_opendir, (const char *path), { return Module.ubveIO.opendir(UTF8ToString(path)); });
EM_JS(int, js_readdir, (int handle, int ptr, int capacity), {
  const name = Module.ubveIO.readdir(handle);
  if (name === null) return 1;
  if (lengthBytesUTF8(name) >= capacity) return -1;
  stringToUTF8(name, ptr, capacity); return 0;
});
EM_JS(void, js_closedir, (int handle), { Module.ubveIO.closedir(handle); });
EM_JS(int, js_blocks, (unsigned lba, int ptr, unsigned count), { return Module.ubveIO.blocks(lba, HEAPU8, ptr, count); });
EM_JS(unsigned, js_block_count, (), { return Module.ubveIO.blockCount(); });

static int block_read(udfread_block_input *input, uint32_t lba, void *buf, uint32_t blocks, int flags) {
  (void)input; (void)flags;
  uint32_t done = 0;
  while (done < blocks) {
    uint32_t n = blocks - done; if (n > MAX_READ / 2048) n = MAX_READ / 2048;
    if ((uint64_t)lba + done + n > UINT32_MAX) return 0;
    int got = js_blocks(lba + done, (int)((uint8_t *)buf + done * 2048), n);
    if (got < 0 || (unsigned)got != n) return 0;
    done += n;
  }
  return done;
}
static uint32_t block_size(udfread_block_input *input) { (void)input; return js_block_count(); }
static int block_close(udfread_block_input *input) { (void)input; return 0; }
static udfread_block_input block_input = { .close = block_close, .read = block_read, .size = block_size };

typedef struct { int handle; int64_t pos; int64_t size; UDFFILE *uf; } file_state;
static void file_close_readonly(BD_FILE_H *f) {
  file_state *s = f->internal; if (s->uf) udfread_file_close(s->uf); else js_close(s->handle);
  free(s); free(f);
}
static int64_t file_seek_readonly(BD_FILE_H *f, int64_t offset, int32_t origin) {
  file_state *s = f->internal;
  if (origin != 0 && origin != 1 && origin != 2) return -1;
  int64_t base = origin == 0 ? 0 : origin == 1 ? s->pos : s->size;
  if ((offset > 0 && base > INT64_MAX - offset) || (offset < 0 && offset < -base)) return -1;
  int64_t position = base + offset;
  if (position < 0 || position > s->size) return -1;
  if (s->uf && udfread_file_seek(s->uf, position, UDF_SEEK_SET) != position) return -1;
  s->pos = position; return position;
}
static int64_t file_tell_readonly(BD_FILE_H *f) { return ((file_state *)f->internal)->pos; }
static int file_eof_readonly(BD_FILE_H *f) { file_state *s=f->internal; return s->pos >= s->size; }
static int64_t file_read_readonly(BD_FILE_H *f, uint8_t *buf, int64_t size) {
  file_state *s = f->internal; if (size < 0) return -1;
  if (size > s->size - s->pos) size = s->size - s->pos;
  int64_t done = 0;
  while (done < size) {
    int n = size - done > MAX_READ ? MAX_READ : (int)(size - done);
    int got = s->uf ? (int)udfread_file_read(s->uf, buf + done, n) : js_read(s->handle, (double)s->pos, (int)(buf + done), n);
    if (got < 0 || got > n) return -1; if (got == 0) break;
    s->pos += got; done += got;
  }
  return done;
}
static int64_t file_write_refused(BD_FILE_H *f,const uint8_t *buf,int64_t size) { (void)f;(void)buf;(void)size;return -1; }
static BD_FILE_H *open_file(void *handle, const char *path) {
  (void)handle;
  file_state *s=calloc(1,sizeof(*s)); if (!s) return NULL;
  if (image_mode) { s->uf=udfread_file_open(volume,path); if (!s->uf) { free(s);return NULL; } s->size=udfread_file_size(s->uf); }
  else { s->handle=js_open(path); if (s->handle < 0) { free(s);return NULL; } s->size=(int64_t)js_size(s->handle); }
  if(s->size<0){if(s->uf)udfread_file_close(s->uf);else js_close(s->handle);free(s);return NULL;}
  BD_FILE_H *f=calloc(1,sizeof(*f)); if (!f) { if(s->uf)udfread_file_close(s->uf);else js_close(s->handle);free(s);return NULL; }
  f->internal=s; f->close=file_close_readonly;f->seek=file_seek_readonly;f->tell=file_tell_readonly;f->eof=file_eof_readonly;f->read=file_read_readonly;f->write=file_write_refused;return f;
}
typedef struct { int handle; UDFDIR *ud; unsigned count; } dir_state;
static int dir_read(BD_DIR_H *dir, BD_DIRENT *entry) {
  dir_state *s=dir->internal; if(++s->count > 4096)return -1;
  if(s->ud) { struct udfread_dirent e;if(!udfread_readdir(s->ud,&e))return 1; if(strlen(e.d_name)>=sizeof(entry->d_name))return -1; strcpy(entry->d_name,e.d_name); return 0; }
  return js_readdir(s->handle,(int)entry->d_name,sizeof(entry->d_name));
}
static void dir_close(BD_DIR_H *dir) { dir_state *s=dir->internal;if(s->ud)udfread_closedir(s->ud);else js_closedir(s->handle);free(s);free(dir); }
static BD_DIR_H *open_dir(void *handle,const char *path) {
  (void)handle; dir_state *s=calloc(1,sizeof(*s));if(!s)return NULL;
  if(image_mode){s->ud=udfread_opendir(volume,path);if(!s->ud){free(s);return NULL;}}
  else{s->handle=js_opendir(path);if(s->handle<0){free(s);return NULL;}}
  BD_DIR_H *d=calloc(1,sizeof(*d));if(!d){if(s->ud)udfread_closedir(s->ud);else js_closedir(s->handle);free(s);return NULL;}
  d->internal=s;d->read=dir_read;d->close=dir_close;return d;
}
static void append(const char *format, ...) {
  if(json_error)return;va_list args;va_start(args,format);int n=vsnprintf(json+json_pos,MAX_JSON-json_pos,format,args);va_end(args);
  if(n<0 || (size_t)n>=MAX_JSON-json_pos){json_error=1;return;}json_pos+=n;
}
static void streams(const BLURAY_STREAM_INFO *ss,unsigned n) {
  append("[");for(unsigned j=0;j<n;j++){if(j)append(",");append("{\"pid\":%u,\"codingType\":%u,\"format\":%u,\"rate\":%u,\"dynamicRange\":%u,\"colorSpace\":%u}",ss[j].pid,ss[j].coding_type,ss[j].format,ss[j].rate,ss[j].dynamic_range_type,ss[j].color_space);}append("]");
}
EMSCRIPTEN_KEEPALIVE void ubve_disc_close(void) {
  if(disc){bd_close(disc);disc=NULL;}
  for(unsigned i=0;i<MAX_HANDLES;i++)if(udf_files[i]){udfread_file_close(udf_files[i]);udf_files[i]=NULL;}
  if(volume){udfread_close(volume);volume=NULL;}
}
EMSCRIPTEN_KEEPALIVE int ubve_udf_open(void) {
  ubve_disc_close();image_mode=1;volume=udfread_init();if(!volume)return 0;
  if(udfread_open_input(volume,&block_input)<0){udfread_close(volume);volume=NULL;return 0;}return 1;
}
EMSCRIPTEN_KEEPALIVE int ubve_disc_open(int iso) {
  if(iso){if(!volume && !ubve_udf_open())return 0;}else{ubve_disc_close();image_mode=0;}
  disc=bd_init();if(!disc)return 0;if(!bd_open_files(disc,NULL,open_dir,open_file)){bd_close(disc);disc=NULL;return 0;}
  const BLURAY_DISC_INFO *info=bd_get_disc_info(disc);if(info && (info->aacs_detected || info->bdplus_detected)){bd_close(disc);disc=NULL;return -2;}return 1;
}
EMSCRIPTEN_KEEPALIVE const char *ubve_disc_titles(void) {
  if(!disc)return NULL;json_pos=0;json_error=0;unsigned count=bd_get_titles(disc,TITLES_ALL,0);if(count>1024)return NULL;
  append("{\"provider\":\"libbluray-1.5.0\",\"timeBase\":\"1/90000\",\"titles\":[");
  for(unsigned i=0;i<count;i++){
    BLURAY_TITLE_INFO *t=bd_get_title_info(disc,i,0);if(!t){json_error=1;break;}
    if(t->clip_count>1024 || t->chapter_count>10000){bd_free_title_info(t);json_error=1;break;}
    if(i)append(",");append("{\"index\":%u,\"playlist\":%u,\"duration90k\":\"%llu\",\"angles\":%u,\"clips\":[",i,t->playlist,(unsigned long long)t->duration,t->angle_count);
    for(unsigned j=0;j<t->clip_count;j++){
      BLURAY_CLIP_INFO *c=&t->clips[j];if(j)append(",");
      if(strspn(c->clip_id,"0123456789")!=5){json_error=1;break;}
      append("{\"id\":\"%s\",\"start90k\":\"%llu\",\"in90k\":\"%llu\",\"out90k\":\"%llu\",\"stillMode\":%u,\"video\":",c->clip_id,(unsigned long long)c->start_time,(unsigned long long)c->in_time,(unsigned long long)c->out_time,c->still_mode);
      streams(c->video_streams,c->video_stream_count);append(",\"audio\":");streams(c->audio_streams,c->audio_stream_count);append(",\"pgs\":");streams(c->pg_streams,c->pg_stream_count);append("}");
    }
    append("],\"chapters\":[");for(unsigned j=0;j<t->chapter_count;j++){if(j)append(",");append("{\"start90k\":\"%llu\",\"duration90k\":\"%llu\",\"clip\":%u}",(unsigned long long)t->chapters[j].start,(unsigned long long)t->chapters[j].duration,t->chapters[j].clip_ref);}append("]}");bd_free_title_info(t);
  }
  append("]}");return json_error?NULL:json;
}
EMSCRIPTEN_KEEPALIVE int ubve_udf_file_open(const char *path) { if(!volume)return -1;for(unsigned i=0;i<MAX_HANDLES;i++)if(!udf_files[i]){udf_files[i]=udfread_file_open(volume,path);return udf_files[i]?(int)i:-1;}return -1; }
EMSCRIPTEN_KEEPALIVE double ubve_udf_file_size(int h){return h>=0&&h<MAX_HANDLES&&udf_files[h]?(double)udfread_file_size(udf_files[h]):-1;}
EMSCRIPTEN_KEEPALIVE int ubve_udf_read(int h,double offset,void *buffer,int length){if(h<0||h>=MAX_HANDLES||!udf_files[h]||length<0||length>MAX_READ||offset<0||offset>9007199254740991.0)return -1;int64_t pos=(int64_t)offset;if(udfread_file_seek(udf_files[h],pos,UDF_SEEK_SET)!=pos)return -1;return udfread_file_read(udf_files[h],buffer,length);}
EMSCRIPTEN_KEEPALIVE void ubve_udf_file_close(int h){if(h>=0&&h<MAX_HANDLES&&udf_files[h]){udfread_file_close(udf_files[h]);udf_files[h]=NULL;}}

static void json_string(const char *value) {
  append("\"");for(const unsigned char *p=(const unsigned char *)value;*p;p++){
    if(*p=='"' || *p=='\\')append("\\%c",*p);else if(*p<32)append("\\u%04x",*p);else append("%c",*p);
  }append("\"");
}
EMSCRIPTEN_KEEPALIVE const char *ubve_udf_list(const char *path) {
  if(!volume)return NULL;UDFDIR *d=udfread_opendir(volume,path);if(!d)return NULL;json_pos=0;json_error=0;append("[");
  struct udfread_dirent e;unsigned count=0;while(udfread_readdir(d,&e)){if(++count>4096){json_error=1;break;}if(count>1)append(",");append("{\"name\":");json_string(e.d_name);append(",\"directory\":%s}",e.d_type==UDF_DT_DIR?"true":"false");}
  append("]");udfread_closedir(d);return json_error?NULL:json;
}
