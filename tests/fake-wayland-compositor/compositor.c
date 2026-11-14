/*
 * A tiny Wayland compositor for testing touchpad swipes in Helide.
 *
 * It implements just enough of the protocol for Chromium's Ozone Wayland
 * backend (wl_compositor, wl_shm, xdg_shell, wl_seat with a pointer,
 * wl_output, zwp_pointer_gestures_v1) and is driven by commands on stdin:
 *
 *   enter X Y             pointer enters the toplevel at X,Y
 *   motion X Y            pointer moves
 *   swipe_begin N         a swipe with N fingers begins
 *   swipe_update DX DY    one frame of finger motion
 *   swipe_end CANCELLED   0 = fingers lifted, 1 = cancelled by the compositor
 *   dump PATH             write the toplevel's latest frame as a PPM image
 *   size                  print the latest frame size, state and the app-id
 *   activate 0|1          configure the toplevel as inactive or active
 *   click X Y             left button press and release at X,Y
 *   popups                print the live subsurfaces (position, size) and the
 *                         xdg popups asked for since the last call (anchor
 *                         rect, size, anchor edge, gravity, offset,
 *                         constraint adjustment)
 *   quit
 *
 * Each command prints "ok ..." or "error ..." on stdout. No real input
 * devices are used, so it cannot affect a running desktop session.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <linux/input-event-codes.h>
#include <wayland-server.h>

#include "pointer-gestures-unstable-v1-server-protocol.h"
#include "xdg-shell-server-protocol.h"

#define WIDTH 1280
#define HEIGHT 800

struct surface {
  struct wl_resource* resource;
  struct wl_resource* pending_buffer;
  int buffer_w, buffer_h;
  bool has_commit;
  bool is_toplevel;
};

struct frame_cb {
  struct wl_resource* resource;
  struct wl_list link;
};

static struct wl_display* display;
static struct wl_event_source* frame_timer_source;
static struct wl_list frame_callbacks;
static struct surface* toplevel_surface;
static struct wl_resource* pointer_resource;
static struct wl_resource* swipe_resource;
static struct wl_resource* toplevel_resource;
static struct wl_resource* toplevel_xdg_surface;
static uint32_t serial_counter = 100;
static uint8_t* latest_pixels;
static int latest_w, latest_h, latest_stride;
static uint32_t latest_format;
static unsigned long commits;
static unsigned long subsurfaces, toplevels;

static uint32_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

static uint32_t next_serial(void) { return ++serial_counter; }

/* Requests that need no action. Each is cast to the request's prototype; the
 * arguments are never read, which is fine on the x86-64 System V ABI. */
static void noop() {}
#define NOOP ((void*)noop)

/* The "destroy" request: the library passes (client, resource). */
static void destroy_request(struct wl_client* client, struct wl_resource* resource) {
  wl_resource_destroy(resource);
}

/* ---- wl_surface ---- */
static void surface_destroy(struct wl_resource* r) {
  struct surface* s = wl_resource_get_user_data(r);
  if (toplevel_surface == s) toplevel_surface = NULL;
  free(s);
}
static void surface_attach(struct wl_client* c, struct wl_resource* r,
                           struct wl_resource* buffer, int32_t x, int32_t y) {
  struct surface* s = wl_resource_get_user_data(r);
  s->pending_buffer = buffer;
}
static void frame_cb_destroy(struct wl_resource* r) {
  struct frame_cb* cb = wl_resource_get_user_data(r);
  wl_list_remove(&cb->link);
  free(cb);
}
static void surface_frame(struct wl_client* c, struct wl_resource* r,
                          uint32_t id) {
  struct frame_cb* cb = calloc(1, sizeof *cb);
  cb->resource = wl_resource_create(c, &wl_callback_interface, 1, id);
  wl_resource_set_implementation(cb->resource, NULL, cb, frame_cb_destroy);
  wl_list_insert(frame_callbacks.prev, &cb->link);
}
static void surface_commit(struct wl_client* c, struct wl_resource* r) {
  struct surface* s = wl_resource_get_user_data(r);
  s->has_commit = true;
  ++commits;
  if (s->pending_buffer) {
    struct wl_shm_buffer* shm = wl_shm_buffer_get(s->pending_buffer);
    if (shm) {
      s->buffer_w = wl_shm_buffer_get_width(shm);
      s->buffer_h = wl_shm_buffer_get_height(shm);
    }
    if (shm && s->is_toplevel) {
      int w = wl_shm_buffer_get_width(shm), h = wl_shm_buffer_get_height(shm);
      int stride = wl_shm_buffer_get_stride(shm);
      free(latest_pixels);
      latest_pixels = malloc((size_t)stride * h);
      wl_shm_buffer_begin_access(shm);
      memcpy(latest_pixels, wl_shm_buffer_get_data(shm), (size_t)stride * h);
      wl_shm_buffer_end_access(shm);
      latest_w = w; latest_h = h; latest_stride = stride;
      latest_format = wl_shm_buffer_get_format(shm);
    }
    wl_buffer_send_release(s->pending_buffer);
    s->pending_buffer = NULL;
  }
}
static const struct wl_surface_interface surface_impl = {
    .destroy = destroy_request,
    .attach = surface_attach,
    .damage = NOOP,
    .frame = surface_frame,
    .set_opaque_region = NOOP,
    .set_input_region = NOOP,
    .commit = surface_commit,
    .set_buffer_transform = NOOP,
    .set_buffer_scale = NOOP,
    .damage_buffer = NOOP,
    .offset = NOOP,
};

/* ---- wl_compositor / wl_region / wl_subcompositor ---- */
static const struct wl_region_interface region_impl = {
    .destroy = destroy_request, .add = NOOP, .subtract = NOOP};
static void compositor_create_surface(struct wl_client* c,
                                      struct wl_resource* r, uint32_t id) {
  struct surface* s = calloc(1, sizeof *s);
  s->resource =
      wl_resource_create(c, &wl_surface_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(s->resource, &surface_impl, s, surface_destroy);
}
static void compositor_create_region(struct wl_client* c, struct wl_resource* r,
                                     uint32_t id) {
  struct wl_resource* region = wl_resource_create(c, &wl_region_interface, 1, id);
  wl_resource_set_implementation(region, &region_impl, NULL, NULL);
}
static const struct wl_compositor_interface compositor_impl = {
    .create_surface = compositor_create_surface,
    .create_region = compositor_create_region};
static void bind_compositor(struct wl_client* c, void* d, uint32_t v, uint32_t id) {
  struct wl_resource* r = wl_resource_create(c, &wl_compositor_interface, v, id);
  wl_resource_set_implementation(r, &compositor_impl, NULL, NULL);
}

/* Subsurfaces (Chromium draws some bubbles in them) and where they were put. */
#define MAX_SUBSURFACES 32
static struct {
  struct wl_resource* sub;
  struct wl_resource* surface;
  int x, y;
} subsurface_list[MAX_SUBSURFACES];
static void subsurface_gone(struct wl_resource* r) {
  for (int i = 0; i < MAX_SUBSURFACES; ++i)
    if (subsurface_list[i].sub == r) subsurface_list[i].sub = NULL;
}
static void subsurface_set_position(struct wl_client* c, struct wl_resource* r,
                                    int32_t x, int32_t y) {
  for (int i = 0; i < MAX_SUBSURFACES; ++i)
    if (subsurface_list[i].sub == r) { subsurface_list[i].x = x; subsurface_list[i].y = y; }
}
static const struct wl_subsurface_interface subsurface_impl = {
    .destroy = destroy_request, .set_position = subsurface_set_position,
    .place_above = NOOP, .place_below = NOOP, .set_sync = NOOP, .set_desync = NOOP};
static void subcompositor_get_subsurface(struct wl_client* c,
                                         struct wl_resource* r, uint32_t id,
                                         struct wl_resource* surface,
                                         struct wl_resource* parent) {
  ++subsurfaces;
  struct wl_resource* sub = wl_resource_create(c, &wl_subsurface_interface, 1, id);
  wl_resource_set_implementation(sub, &subsurface_impl, NULL, subsurface_gone);
  for (int i = 0; i < MAX_SUBSURFACES; ++i) {
    if (!subsurface_list[i].sub) {
      subsurface_list[i].sub = sub;
      subsurface_list[i].surface = surface;
      subsurface_list[i].x = subsurface_list[i].y = 0;
      break;
    }
  }
}
static const struct wl_subcompositor_interface subcompositor_impl = {
    .destroy = destroy_request,
    .get_subsurface = subcompositor_get_subsurface};
static void bind_subcompositor(struct wl_client* c, void* d, uint32_t v, uint32_t id) {
  struct wl_resource* r = wl_resource_create(c, &wl_subcompositor_interface, v, id);
  wl_resource_set_implementation(r, &subcompositor_impl, NULL, NULL);
}

/* ---- wl_output ---- */
static const struct wl_output_interface output_impl = {
    .release = destroy_request};
static void bind_output(struct wl_client* c, void* d, uint32_t v, uint32_t id) {
  struct wl_resource* r = wl_resource_create(c, &wl_output_interface, v, id);
  wl_resource_set_implementation(r, &output_impl, NULL, NULL);
  wl_output_send_geometry(r, 0, 0, 340, 210, WL_OUTPUT_SUBPIXEL_UNKNOWN, "test",
                          "test", WL_OUTPUT_TRANSFORM_NORMAL);
  wl_output_send_mode(r, WL_OUTPUT_MODE_CURRENT | WL_OUTPUT_MODE_PREFERRED,
                      WIDTH, HEIGHT, 60000);
  if (v >= 2) {
    wl_output_send_scale(r, 1);
    wl_output_send_done(r);
  }
}

/* ---- wl_seat / wl_pointer ---- */
static const struct wl_pointer_interface pointer_impl = {
    .set_cursor = NOOP, .release = destroy_request};
static void pointer_gone(struct wl_resource* r) {
  if (pointer_resource == r) pointer_resource = NULL;
}
static void seat_get_pointer(struct wl_client* c, struct wl_resource* r, uint32_t id) {
  struct wl_resource* p =
      wl_resource_create(c, &wl_pointer_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(p, &pointer_impl, NULL, pointer_gone);
  pointer_resource = p;
}
static const struct wl_seat_interface seat_impl = {
    .get_pointer = seat_get_pointer, .get_keyboard = NOOP, .get_touch = NOOP,
    .release = destroy_request};
static void bind_seat(struct wl_client* c, void* d, uint32_t v, uint32_t id) {
  struct wl_resource* r = wl_resource_create(c, &wl_seat_interface, v, id);
  wl_resource_set_implementation(r, &seat_impl, NULL, NULL);
  wl_seat_send_capabilities(r, WL_SEAT_CAPABILITY_POINTER);
  if (v >= 2) wl_seat_send_name(r, "test-seat");
}

/* ---- xdg_shell ---- */
static char app_id[128] = "";
static void toplevel_set_app_id(struct wl_client* c, struct wl_resource* r,
                                const char* id) {
  snprintf(app_id, sizeof app_id, "%s", id);
}
static const struct xdg_toplevel_interface toplevel_impl = {
    .destroy = destroy_request, .set_parent = NOOP, .set_title = NOOP,
    .set_app_id = toplevel_set_app_id, .show_window_menu = NOOP, .move = NOOP, .resize = NOOP,
    .set_max_size = NOOP, .set_min_size = NOOP, .set_maximized = NOOP,
    .unset_maximized = NOOP, .set_fullscreen = NOOP, .unset_fullscreen = NOOP,
    .set_minimized = NOOP};
static const struct xdg_popup_interface popup_impl = {
    .destroy = destroy_request, .grab = NOOP, .reposition = NOOP};
struct positioner {
  int32_t ax, ay, aw, ah, w, h, ox, oy;
  uint32_t anchor, gravity, constraint;
};
static void positioner_destroy(struct wl_resource* r) {
  free(wl_resource_get_user_data(r));
}
#define POSITIONER(r) ((struct positioner*)wl_resource_get_user_data(r))
static void positioner_set_size(struct wl_client* c, struct wl_resource* r,
                                int32_t w, int32_t h) {
  POSITIONER(r)->w = w; POSITIONER(r)->h = h;
}
static void positioner_set_anchor_rect(struct wl_client* c, struct wl_resource* r,
                                       int32_t x, int32_t y, int32_t w, int32_t h) {
  struct positioner* p = POSITIONER(r);
  p->ax = x; p->ay = y; p->aw = w; p->ah = h;
}
static void positioner_set_anchor(struct wl_client* c, struct wl_resource* r,
                                  uint32_t a) { POSITIONER(r)->anchor = a; }
static void positioner_set_gravity(struct wl_client* c, struct wl_resource* r,
                                   uint32_t g) { POSITIONER(r)->gravity = g; }
static void positioner_set_constraint(struct wl_client* c, struct wl_resource* r,
                                      uint32_t a) { POSITIONER(r)->constraint = a; }
static void positioner_set_offset(struct wl_client* c, struct wl_resource* r,
                                  int32_t x, int32_t y) {
  POSITIONER(r)->ox = x; POSITIONER(r)->oy = y;
}
static const struct xdg_positioner_interface positioner_impl = {
    .destroy = destroy_request, .set_size = positioner_set_size,
    .set_anchor_rect = positioner_set_anchor_rect, .set_anchor = positioner_set_anchor,
    .set_gravity = positioner_set_gravity,
    .set_constraint_adjustment = positioner_set_constraint,
    .set_offset = positioner_set_offset, .set_reactive = NOOP,
    .set_parent_size = NOOP, .set_parent_configure = NOOP};

/* The popups asked for, newest last. */
static char popup_log[8192];

static void toplevel_gone(struct wl_resource* r) {
  if (toplevel_resource == r) toplevel_resource = NULL;
}
static void send_toplevel_configure(bool activated) {
  struct wl_array states;
  wl_array_init(&states);
  if (activated) {
    *(uint32_t*)wl_array_add(&states, sizeof(uint32_t)) = XDG_TOPLEVEL_STATE_ACTIVATED;
  }
  xdg_toplevel_send_configure(toplevel_resource, WIDTH, HEIGHT, &states);
  wl_array_release(&states);
  xdg_surface_send_configure(toplevel_xdg_surface, next_serial());
}
static void xdg_surface_get_toplevel(struct wl_client* c, struct wl_resource* r,
                                     uint32_t id) {
  struct surface* s = wl_resource_get_user_data(r);
  ++toplevels;
  s->is_toplevel = true;
  toplevel_surface = s;
  struct wl_resource* t =
      wl_resource_create(c, &xdg_toplevel_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(t, &toplevel_impl, s, toplevel_gone);
  toplevel_resource = t;
  toplevel_xdg_surface = r;
  send_toplevel_configure(true);
}
static void xdg_surface_get_popup(struct wl_client* c, struct wl_resource* r,
                                  uint32_t id, struct wl_resource* parent,
                                  struct wl_resource* positioner) {
  struct wl_resource* p =
      wl_resource_create(c, &xdg_popup_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(p, &popup_impl, NULL, NULL);
  struct positioner* pos = POSITIONER(positioner);
  size_t used = strlen(popup_log);
  snprintf(popup_log + used, sizeof popup_log - used,
           "popup anchor_rect=%d,%d,%dx%d size=%dx%d anchor=%u gravity=%u offset=%d,%d constraint=%u;",
           pos->ax, pos->ay, pos->aw, pos->ah, pos->w, pos->h, pos->anchor, pos->gravity,
           pos->ox, pos->oy, pos->constraint);
  if (strlen(popup_log) > sizeof popup_log - 300) popup_log[0] = 0;
  xdg_popup_send_configure(p, 0, 0, pos->w ? pos->w : 200, pos->h ? pos->h : 200);
  xdg_surface_send_configure(r, next_serial());
}
static const struct xdg_surface_interface xdg_surface_impl = {
    .destroy = destroy_request,
    .get_toplevel = xdg_surface_get_toplevel,
    .get_popup = xdg_surface_get_popup,
    .set_window_geometry = NOOP,
    .ack_configure = NOOP};
static void wm_base_get_xdg_surface(struct wl_client* c, struct wl_resource* r,
                                    uint32_t id, struct wl_resource* surface) {
  struct wl_resource* x =
      wl_resource_create(c, &xdg_surface_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(x, &xdg_surface_impl,
                                 wl_resource_get_user_data(surface), NULL);
}
static void wm_base_create_positioner(struct wl_client* c, struct wl_resource* r,
                                      uint32_t id) {
  struct wl_resource* p =
      wl_resource_create(c, &xdg_positioner_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(p, &positioner_impl, calloc(1, sizeof(struct positioner)),
                                 positioner_destroy);
}
static const struct xdg_wm_base_interface wm_base_impl = {
    .destroy = destroy_request,
    .create_positioner = wm_base_create_positioner,
    .get_xdg_surface = wm_base_get_xdg_surface,
    .pong = NOOP};
static void bind_wm_base(struct wl_client* c, void* d, uint32_t v, uint32_t id) {
  struct wl_resource* r = wl_resource_create(c, &xdg_wm_base_interface, v, id);
  wl_resource_set_implementation(r, &wm_base_impl, NULL, NULL);
}

/* ---- zwp_pointer_gestures_v1 ---- */
static const struct zwp_pointer_gesture_swipe_v1_interface swipe_impl = {
    .destroy = destroy_request};
static const struct zwp_pointer_gesture_pinch_v1_interface pinch_impl = {
    .destroy = destroy_request};
static const struct zwp_pointer_gesture_hold_v1_interface hold_impl = {
    .destroy = destroy_request};
static void swipe_gone(struct wl_resource* r) {
  if (swipe_resource == r) swipe_resource = NULL;
}
static void gestures_get_swipe(struct wl_client* c, struct wl_resource* r,
                               uint32_t id, struct wl_resource* pointer) {
  struct wl_resource* s = wl_resource_create(
      c, &zwp_pointer_gesture_swipe_v1_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(s, &swipe_impl, NULL, swipe_gone);
  swipe_resource = s;
}
static void gestures_get_pinch(struct wl_client* c, struct wl_resource* r,
                               uint32_t id, struct wl_resource* pointer) {
  struct wl_resource* p = wl_resource_create(
      c, &zwp_pointer_gesture_pinch_v1_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(p, &pinch_impl, NULL, NULL);
}
static void gestures_get_hold(struct wl_client* c, struct wl_resource* r,
                              uint32_t id, struct wl_resource* pointer) {
  struct wl_resource* h = wl_resource_create(
      c, &zwp_pointer_gesture_hold_v1_interface, wl_resource_get_version(r), id);
  wl_resource_set_implementation(h, &hold_impl, NULL, NULL);
}
static const struct zwp_pointer_gestures_v1_interface gestures_impl = {
    .get_swipe_gesture = gestures_get_swipe,
    .get_pinch_gesture = gestures_get_pinch,
    .get_hold_gesture = gestures_get_hold,
    .release = destroy_request};
static void bind_gestures(struct wl_client* c, void* d, uint32_t v, uint32_t id) {
  struct wl_resource* r =
      wl_resource_create(c, &zwp_pointer_gestures_v1_interface, v, id);
  wl_resource_set_implementation(r, &gestures_impl, NULL, NULL);
}

/* ---- frame callbacks ---- */
static int frame_timer(void* data) {
  struct frame_cb *cb, *tmp;
  uint32_t t = now_ms();
  wl_list_for_each_safe(cb, tmp, &frame_callbacks, link) {
    wl_callback_send_done(cb->resource, t);
    wl_resource_destroy(cb->resource);
  }
  wl_event_source_timer_update(frame_timer_source, 16);
  return 0;
}

/* ---- commands ---- */
static void reply(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void reply(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vprintf(fmt, ap);
  va_end(ap);
  putchar('\n');
  fflush(stdout);
}

static int dump_ppm(const char* path) {
  if (!latest_pixels) return -1;
  FILE* f = fopen(path, "wb");
  if (!f) return -1;
  fprintf(f, "P6\n%d %d\n255\n", latest_w, latest_h);
  for (int y = 0; y < latest_h; ++y) {
    const uint8_t* row = latest_pixels + (size_t)y * latest_stride;
    for (int x = 0; x < latest_w; ++x) {
      /* ARGB8888 / XRGB8888 are little-endian B,G,R,A in memory. */
      uint8_t rgb[3] = {row[x * 4 + 2], row[x * 4 + 1], row[x * 4 + 0]};
      fwrite(rgb, 1, 3, f);
    }
  }
  fclose(f);
  return 0;
}

static void handle_command(char* line) {
  char cmd[32] = "";
  double a = 0, b = 0;
  char path[512] = "";
  if (sscanf(line, "%31s", cmd) != 1) return;
  if (!strcmp(cmd, "enter") || !strcmp(cmd, "motion")) {
    if (sscanf(line, "%*s %lf %lf", &a, &b) != 2 || !pointer_resource || !toplevel_surface) {
      return reply("error %s: needs a pointer and a toplevel", cmd);
    }
    if (!strcmp(cmd, "enter")) {
      wl_pointer_send_enter(pointer_resource, next_serial(),
                            toplevel_surface->resource, wl_fixed_from_double(a),
                            wl_fixed_from_double(b));
    } else {
      wl_pointer_send_motion(pointer_resource, now_ms(), wl_fixed_from_double(a),
                             wl_fixed_from_double(b));
    }
    if (wl_resource_get_version(pointer_resource) >= 5) wl_pointer_send_frame(pointer_resource);
    return reply("ok %s", cmd);
  }
  if (!strcmp(cmd, "swipe_begin")) {
    if (sscanf(line, "%*s %lf", &a) != 1 || !swipe_resource || !toplevel_surface) {
      return reply("error swipe_begin: client has no swipe gesture object");
    }
    zwp_pointer_gesture_swipe_v1_send_begin(swipe_resource, next_serial(), now_ms(),
                                            toplevel_surface->resource, (uint32_t)a);
    return reply("ok swipe_begin");
  }
  if (!strcmp(cmd, "swipe_update")) {
    if (sscanf(line, "%*s %lf %lf", &a, &b) != 2 || !swipe_resource) {
      return reply("error swipe_update");
    }
    zwp_pointer_gesture_swipe_v1_send_update(swipe_resource, now_ms(),
                                             wl_fixed_from_double(a),
                                             wl_fixed_from_double(b));
    return reply("ok swipe_update");
  }
  if (!strcmp(cmd, "swipe_end")) {
    if (sscanf(line, "%*s %lf", &a) != 1 || !swipe_resource) return reply("error swipe_end");
    zwp_pointer_gesture_swipe_v1_send_end(swipe_resource, next_serial(), now_ms(), (int32_t)a);
    return reply("ok swipe_end");
  }
  if (!strcmp(cmd, "dump")) {
    if (sscanf(line, "%*s %511s", path) != 1 || dump_ppm(path)) return reply("error dump");
    return reply("ok dump %dx%d", latest_w, latest_h);
  }
  if (!strcmp(cmd, "size")) {
    return reply("ok size %d %d commits=%lu toplevel=%d swipe=%d pointer=%d app_id=%s",
                 latest_w, latest_h, commits, toplevel_surface != NULL,
                 swipe_resource != NULL, pointer_resource != NULL, app_id);
  }
  if (!strcmp(cmd, "activate")) {
    if (sscanf(line, "%*s %lf", &a) != 1 || !toplevel_resource) return reply("error activate");
    send_toplevel_configure(a != 0);
    return reply("ok activate %d", a != 0);
  }
  if (!strcmp(cmd, "click")) {
    if (sscanf(line, "%*s %lf %lf", &a, &b) != 2 || !pointer_resource || !toplevel_surface) {
      return reply("error click");
    }
    wl_pointer_send_motion(pointer_resource, now_ms(), wl_fixed_from_double(a),
                           wl_fixed_from_double(b));
    if (wl_resource_get_version(pointer_resource) >= 5) wl_pointer_send_frame(pointer_resource);
    wl_pointer_send_button(pointer_resource, next_serial(), now_ms(), BTN_LEFT,
                           WL_POINTER_BUTTON_STATE_PRESSED);
    if (wl_resource_get_version(pointer_resource) >= 5) wl_pointer_send_frame(pointer_resource);
    wl_pointer_send_button(pointer_resource, next_serial(), now_ms(), BTN_LEFT,
                           WL_POINTER_BUTTON_STATE_RELEASED);
    if (wl_resource_get_version(pointer_resource) >= 5) wl_pointer_send_frame(pointer_resource);
    return reply("ok click");
  }
  if (!strcmp(cmd, "popups")) {
    char subs[2048] = "";
    for (int i = 0; i < MAX_SUBSURFACES; ++i) {
      if (!subsurface_list[i].sub) continue;
      struct surface* ss = wl_resource_get_user_data(subsurface_list[i].surface);
      size_t used = strlen(subs);
      snprintf(subs + used, sizeof subs - used, "subsurface at=%d,%d size=%dx%d;",
               subsurface_list[i].x, subsurface_list[i].y, ss ? ss->buffer_w : 0,
               ss ? ss->buffer_h : 0);
    }
    reply("ok popups subsurfaces=%lu toplevels=%lu %s %s", subsurfaces, toplevels, subs, popup_log);
    popup_log[0] = 0;
    return;
  }
  if (!strcmp(cmd, "quit")) {
    reply("ok quit");
    return wl_display_terminate(display);
  }
  reply("error unknown command %s", cmd);
}

static int stdin_ready(int fd, uint32_t mask, void* data) {
  static char buffer[1024];
  static size_t used;
  ssize_t n = read(fd, buffer + used, sizeof buffer - used - 1);
  if (n <= 0) {
    wl_display_terminate(display);
    return 0;
  }
  used += (size_t)n;
  char* start = buffer;
  char* nl;
  while ((nl = memchr(start, '\n', buffer + used - start))) {
    *nl = 0;
    handle_command(start);
    start = nl + 1;
  }
  used = (size_t)(buffer + used - start);
  memmove(buffer, start, used);
  return 0;
}

int main(int argc, char** argv) {
  const char* socket = argc > 1 ? argv[1] : "wayland-swipe-test";
  display = wl_display_create();
  wl_list_init(&frame_callbacks);
  if (wl_display_add_socket(display, socket)) {
    fprintf(stderr, "cannot create socket %s (is XDG_RUNTIME_DIR set?)\n", socket);
    return 1;
  }
  wl_display_init_shm(display);
  wl_global_create(display, &wl_compositor_interface, 4, NULL, bind_compositor);
  wl_global_create(display, &wl_subcompositor_interface, 1, NULL, bind_subcompositor);
  wl_global_create(display, &wl_output_interface, 3, NULL, bind_output);
  wl_global_create(display, &wl_seat_interface, 5, NULL, bind_seat);
  wl_global_create(display, &xdg_wm_base_interface, 3, NULL, bind_wm_base);
  wl_global_create(display, &zwp_pointer_gestures_v1_interface, 3, NULL, bind_gestures);

  struct wl_event_loop* loop = wl_display_get_event_loop(display);
  frame_timer_source = wl_event_loop_add_timer(loop, frame_timer, NULL);
  wl_event_source_timer_update(frame_timer_source, 16);
  wl_event_loop_add_fd(loop, STDIN_FILENO, WL_EVENT_READABLE, stdin_ready, NULL);

  reply("ready %s", socket);
  wl_display_run(display);
  wl_display_destroy(display);
  return 0;
}
