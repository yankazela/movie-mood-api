import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { APIGatewayProxyEvent } from "aws-lambda";
import { errorResponse } from "../common/responses";
import { countryParam, intParam, listParam, mediaTypesParam, pathParam, queryParam, requireUserId } from "../common/request";
import { ValidationError } from "../../services/common/errors";
import { CatalogBrowseServiceImpl } from "../../services/catalog/CatalogBrowseServiceImpl";
import { PopularSort } from "../../services/catalog/CatalogBrowseService";

// Created once per container so the catalogue scan is cached across invocations.
const browseService = new CatalogBrowseServiceImpl();

/** GET /movies/{itemId}. One catalogue item, with availability and rating for the caller's country. */
export const get = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const item = await browseService.get(requireUserId(event), pathParam(event, "itemId"), countryParam(event));

        return responseService.success({ item });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error fetching movie");
    }
};

/** GET /movies?ids=a,b,c. Several catalogue items at once, in the order asked for. */
export const getMany = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const items = await browseService.getMany(requireUserId(event), listParam(event, "ids"), countryParam(event));

        return responseService.success({ items });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error fetching movies");
    }
};

/** GET /movies/search?q=. Matches titles, then directors and cast, then genres. */
export const search = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const query = queryParam(event, "q");

        if (!query) {
            throw new ValidationError("q is required");
        }

        const items = await browseService.search(
            requireUserId(event),
            { query, mediaTypes: mediaTypesParam(event), limit: intParam(event, "limit") },
            countryParam(event),
        );

        return responseService.success({ items });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error searching movies");
    }
};

/** GET /movies/popular?sort=popularity|rating&services=netflix,prime. What is trending where the caller lives. */
export const popular = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const sort = queryParam(event, "sort") ?? "popularity";

        if (sort !== "popularity" && sort !== "rating") {
            throw new ValidationError("sort must be popularity or rating");
        }

        const items = await browseService.popular(
            requireUserId(event),
            {
                mediaTypes: mediaTypesParam(event),
                services: listParam(event, "services"),
                sort: sort as PopularSort,
                limit: intParam(event, "limit"),
            },
            countryParam(event),
        );

        return responseService.success({ items });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error listing popular movies");
    }
};
